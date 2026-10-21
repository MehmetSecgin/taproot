for (const name of Object.keys(process.env)) {
  if (name.startsWith('TAPROOT_')) delete process.env[name];
}

process.env.TAPROOT_NO_KEYCHAIN = '1';
