import process from 'node:process';

for (const name of Object.keys(process.env)) {
  if (name.startsWith('TAPROOT_')) {
    Reflect.deleteProperty(process.env, name);
  }
}

process.env.TAPROOT_NO_KEYCHAIN = '1';

