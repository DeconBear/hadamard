import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';

export interface OpaqueRelayEnvelope {
  type: 'opaque';
  id: string;
  sequence: number;
  nonce: string;
  ciphertext: string;
}

export class OpaqueRelayCodec {
  private sendSequence = 0;
  private receiveSequence = 0;

  constructor(
    private readonly key: Uint8Array,
    private readonly roomId: string,
  ) {
    if (key.byteLength !== 32) throw new Error('Opaque relay key must be 32 bytes.');
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(roomId)) throw new Error('Invalid opaque relay room ID.');
  }

  seal(value: unknown): OpaqueRelayEnvelope {
    const sequence = this.sendSequence + 1;
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(`${this.roomId}:${sequence}`, 'utf8'));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    const ciphertext = Buffer.concat([body, cipher.getAuthTag()]);
    this.sendSequence = sequence;
    return {
      type: 'opaque',
      id: randomUUID().replace(/-/gu, ''),
      sequence,
      nonce: nonce.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    };
  }

  open(envelope: OpaqueRelayEnvelope): unknown {
    if (envelope.sequence <= this.receiveSequence) throw new Error('Opaque relay sequence was replayed or reordered.');
    const nonce = Buffer.from(envelope.nonce, 'base64url');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64url');
    if (nonce.byteLength !== 12 || ciphertext.byteLength < 17) throw new Error('Invalid opaque relay envelope.');
    const body = ciphertext.subarray(0, -16);
    const tag = ciphertext.subarray(-16);
    const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
    decipher.setAAD(Buffer.from(`${this.roomId}:${envelope.sequence}`, 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
    const value = JSON.parse(plaintext.toString('utf8')) as unknown;
    this.receiveSequence = envelope.sequence;
    return value;
  }
}
