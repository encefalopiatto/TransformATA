import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ssh2 from 'ssh2';
import type { Attributes, Server as SshServer } from 'ssh2';
import type { InboundSftpServerEndpoint } from '@transformata/shared';
import { listEndpoints } from '../config-store.js';
import { errorMessage } from '../errors.js';
import { createJob } from '../queue/queue.js';
import { fromRoot } from '../root.js';
import { getSettings } from '../settings.js';

const { Server, utils } = ssh2;
const { OPEN_MODE, STATUS_CODE } = utils.sftp;

/**
 * Embedded SFTP server (enabled via settings.sftpServerEnabled /
 * SFTP_SERVER_ENABLED). Each enabled inbound `sftp` endpoint is a user
 * (password auth). Implements the minimal SFTP subset needed for uploads:
 * REALPATH, OPEN(write), WRITE, CLOSE, plausible STAT/LSTAT/FSTAT, and
 * tolerant no-op OPENDIR/READDIR/MKDIR etc., so common clients just work.
 * Uploaded files are buffered, written to data/sftp-in/<endpointId>/ and
 * enqueued as jobs on CLOSE.
 */

interface OpenFile {
  kind: 'file';
  name: string;
  buffer: Buffer;
  size: number;
}
interface OpenDir {
  kind: 'dir';
}
type Handle = OpenFile | OpenDir;

function loadHostKey(): Buffer {
  const keyPath = fromRoot('data', 'host.key');
  if (fs.existsSync(keyPath)) return fs.readFileSync(keyPath);
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, pem, { mode: 0o600 });
  console.log(`[sftp-server] generated new RSA host key at ${keyPath}`);
  return Buffer.from(pem);
}

function findSftpUser(
  username: string,
  password: string,
): InboundSftpServerEndpoint | undefined {
  for (const endpoint of listEndpoints('inbound')) {
    if (
      endpoint.direction === 'inbound' &&
      endpoint.kind === 'sftp' &&
      endpoint.enabled !== false &&
      endpoint.username === username &&
      endpoint.password === password
    ) {
      return endpoint;
    }
  }
  return undefined;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);
const dirAttrs = (): Attributes => ({
  mode: 0o40755,
  uid: 0,
  gid: 0,
  size: 0,
  atime: nowSec(),
  mtime: nowSec(),
});
const fileAttrs = (size: number): Attributes => ({
  mode: 0o100644,
  uid: 0,
  gid: 0,
  size,
  atime: nowSec(),
  mtime: nowSec(),
});

export function startSftpServer(): SshServer {
  const settings = getSettings();
  const server = new Server({ hostKeys: [loadHostKey()] }, (client) => {
    let endpoint: InboundSftpServerEndpoint | undefined;

    client.on('authentication', (ctx) => {
      if (ctx.method !== 'password') {
        ctx.reject(['password']);
        return;
      }
      const found = findSftpUser(ctx.username, ctx.password);
      if (!found) {
        console.warn(`[sftp-server] rejected login for user "${ctx.username}"`);
        ctx.reject(['password']);
        return;
      }
      endpoint = found;
      ctx.accept();
    });

    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          let nextHandleId = 1;
          const handles = new Map<number, Handle>();

          const makeHandle = (value: Handle): Buffer => {
            const id = nextHandleId++;
            handles.set(id, value);
            const buf = Buffer.alloc(4);
            buf.writeUInt32BE(id, 0);
            return buf;
          };
          const resolveHandle = (buf: Buffer): { id: number; value: Handle | undefined } => {
            if (buf.length !== 4) return { id: -1, value: undefined };
            const id = buf.readUInt32BE(0);
            return { id, value: handles.get(id) };
          };

          sftp.on('REALPATH', (reqid, givenPath) => {
            const resolved = path.posix.normalize(path.posix.resolve('/', givenPath));
            sftp.name(reqid, [
              {
                filename: resolved,
                longname: `drwxr-xr-x   1 tata     tata            0 Jan  1 00:00 ${resolved}`,
                attrs: dirAttrs(),
              },
            ]);
          });

          sftp.on('OPEN', (reqid, filename, flags) => {
            if (!(flags & OPEN_MODE.WRITE)) {
              sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED, 'only uploads are supported');
              return;
            }
            const name = path.posix.basename(filename) || `upload-${Date.now()}`;
            sftp.handle(
              reqid,
              makeHandle({ kind: 'file', name, buffer: Buffer.alloc(0), size: 0 }),
            );
          });

          sftp.on('WRITE', (reqid, handle, offset, data) => {
            const { value } = resolveHandle(handle);
            if (!value || value.kind !== 'file') {
              sftp.status(reqid, STATUS_CODE.FAILURE, 'invalid file handle');
              return;
            }
            const off = Number(offset);
            const end = off + data.length;
            if (value.buffer.length < end) {
              const grown = Buffer.alloc(Math.max(end, value.buffer.length * 2, 8192));
              value.buffer.copy(grown);
              value.buffer = grown;
            }
            data.copy(value.buffer, off);
            value.size = Math.max(value.size, end);
            sftp.status(reqid, STATUS_CODE.OK);
          });

          sftp.on('CLOSE', (reqid, handle) => {
            const { id, value } = resolveHandle(handle);
            handles.delete(id);
            if (value && value.kind === 'file' && endpoint) {
              const content = value.buffer.subarray(0, value.size);
              try {
                const dir = fromRoot('data', 'sftp-in', endpoint.id);
                fs.mkdirSync(dir, { recursive: true });
                const safeName = path.basename(value.name);
                fs.writeFileSync(path.join(dir, safeName), content);
                const job = createJob(
                  {
                    endpointId: endpoint.id,
                    endpointName: endpoint.name,
                    via: 'sftp',
                    fileName: safeName,
                  },
                  content.toString('utf8'),
                );
                console.log(
                  `[sftp-server] received "${safeName}" (${content.length} bytes) on endpoint ${endpoint.id} → job ${job.id}`,
                );
              } catch (err) {
                console.error(`[sftp-server] failed to ingest upload: ${errorMessage(err)}`);
                sftp.status(reqid, STATUS_CODE.FAILURE, errorMessage(err));
                return;
              }
            }
            sftp.status(reqid, STATUS_CODE.OK);
          });

          sftp.on('FSTAT', (reqid, handle) => {
            const { value } = resolveHandle(handle);
            if (value && value.kind === 'file') sftp.attrs(reqid, fileAttrs(value.size));
            else sftp.attrs(reqid, dirAttrs());
          });

          const statHandler = (reqid: number, statPath: string): void => {
            // Plausible values: directories exist; files (path with an
            // extension) report "no such file" so upload clients treat the
            // target as absent and proceed cleanly.
            const base = path.posix.basename(statPath);
            if (base.includes('.') && base !== '.' && base !== '..') {
              sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE, 'no such file');
            } else {
              sftp.attrs(reqid, dirAttrs());
            }
          };
          sftp.on('STAT', statHandler);
          sftp.on('LSTAT', statHandler);

          sftp.on('OPENDIR', (reqid) => {
            sftp.handle(reqid, makeHandle({ kind: 'dir' }));
          });
          sftp.on('READDIR', (reqid) => {
            sftp.status(reqid, STATUS_CODE.EOF);
          });

          // Tolerant no-ops so common clients don't trip over housekeeping.
          const okHandler = (reqid: number): void => {
            sftp.status(reqid, STATUS_CODE.OK);
          };
          sftp.on('MKDIR', okHandler);
          sftp.on('SETSTAT', okHandler);
          sftp.on('FSETSTAT', okHandler);
          sftp.on('REMOVE', okHandler);
          sftp.on('RMDIR', okHandler);
          sftp.on('RENAME', okHandler);

          sftp.on('READ', (reqid) => {
            sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED, 'downloads are not supported');
          });
        });
      });
    });

    client.on('error', (err) => {
      console.warn(`[sftp-server] client error: ${errorMessage(err)}`);
    });
  });

  server.on('error', (err: Error) => {
    console.error(`[sftp-server] server error: ${errorMessage(err)}`);
  });

  server.listen(settings.sftpPort, '0.0.0.0', () => {
    console.log(`[sftp-server] embedded SFTP server listening on 0.0.0.0:${settings.sftpPort}`);
  });

  return server;
}
