#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <out-dir> <daemon-subject-alt-name, e.g. DNS:taproot-daemon or IP:127.0.0.1>" >&2
  exit 2
fi

out="$1"
daemon_san="$2"
mkdir -p "$out"
cd "$out"

new_key() { openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$1" 2>/dev/null; }

signed_cert() {
  local name="$1" usage="$2" san="$3"
  new_key "$name.key"
  openssl req -new -key "$name.key" -out "$name.csr" -subj "/CN=$name" 2>/dev/null
  printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=%s\n%s\n' "$usage" "$san" > "$name.ext"
  openssl x509 -req -in "$name.csr" -CA ca.crt -CAkey ca.key -CAcreateserial -out "$name.crt" -days 825 -extfile "$name.ext" 2>/dev/null
  rm "$name.csr" "$name.ext"
}

new_key ca.key
openssl req -x509 -new -key ca.key -out ca.crt -days 825 -subj "/CN=taproot-ca" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
signed_cert daemon serverAuth "subjectAltName=$daemon_san"
signed_cert client clientAuth ""
rm -f ca.srl
chmod 600 ./*.key
