import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import type tls from 'node:tls';

export interface MutualTlsFiles {
  caFile: string;
  certFile: string;
  keyFile: string;
}

export interface HostPort {
  host: string;
  port: number;
}

export interface TlsMaterial {
  ca: Buffer;
  cert: Buffer;
  key: Buffer;
}

export function readTlsMaterial(files: MutualTlsFiles): TlsMaterial {
  return { ca: fs.readFileSync(files.caFile), cert: fs.readFileSync(files.certFile), key: fs.readFileSync(files.keyFile) };
}

export function tlsFingerprint(material: TlsMaterial): string {
  return createHash('sha256').update(material.ca).update(material.cert).update(material.key).digest('hex');
}

export function mutualTlsServerOptions(material: TlsMaterial): tls.TlsOptions {
  return { ...material, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' };
}

export function mutualTlsClientOptions(files: MutualTlsFiles, server: HostPort): tls.ConnectionOptions {
  return { ...readTlsMaterial(files), host: server.host, port: server.port, servername: net.isIP(server.host) ? undefined : server.host, rejectUnauthorized: true, minVersion: 'TLSv1.3' };
}
