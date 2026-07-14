#!/usr/bin/env bash
set -euo pipefail

IDENTITY="MAHI Local Distribution"
SIGNING_DIR="$HOME/Library/Application Support/MAHI/Signing"
P12="$SIGNING_DIR/mahi-local-distribution.p12"
PASSWORD_FILE="$SIGNING_DIR/mahi-local-distribution.password"
CERTIFICATE="$SIGNING_DIR/mahi-local-distribution.cer"
LOGIN_KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning 2>/dev/null | grep -Fq "\"$IDENTITY\""; then
  echo "create-local-signing-identity: $IDENTITY already exists"
  exit 0
fi

mkdir -p "$SIGNING_DIR"
chmod 700 "$SIGNING_DIR"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

PASSWORD="$(openssl rand -base64 36)"
printf '%s' "$PASSWORD" > "$PASSWORD_FILE"
chmod 600 "$PASSWORD_FILE"

openssl req -x509 -newkey rsa:3072 -sha256 -days 3650 -nodes \
  -subj "/CN=$IDENTITY/O=MAHI/OU=Local Distribution" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,digitalSignature,keyCertSign" \
  -addext "extendedKeyUsage=critical,codeSigning" \
  -keyout "$TEMP_DIR/private-key.pem" \
  -out "$TEMP_DIR/certificate.pem"

openssl pkcs12 -export -legacy \
  -inkey "$TEMP_DIR/private-key.pem" \
  -in "$TEMP_DIR/certificate.pem" \
  -name "$IDENTITY" \
  -passout "pass:$PASSWORD" \
  -out "$P12"
chmod 600 "$P12"
openssl x509 -in "$TEMP_DIR/certificate.pem" -outform der -out "$CERTIFICATE"
chmod 644 "$CERTIFICATE"

security import "$P12" -k "$LOGIN_KEYCHAIN" -P "$PASSWORD" -T /usr/bin/codesign
security add-trusted-cert -r trustRoot -p codeSign -k "$LOGIN_KEYCHAIN" "$CERTIFICATE"

if ! security find-identity -v -p codesigning | grep -Fq "\"$IDENTITY\""; then
  echo "create-local-signing-identity: identity import failed" >&2
  exit 1
fi

echo "create-local-signing-identity: created $IDENTITY"
echo "Backup this private file securely: $P12"
