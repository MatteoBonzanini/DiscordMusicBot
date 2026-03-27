
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

function encrypt(text, key) {
  const iv = randomBytes(16);

  const cipher = createCipheriv('aes-256-cbc', key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  return {
    iv: iv.toString('hex'),
    encryptedData: encrypted
  };
}       

export function decrypt(encryptedData, iv, key) {
  const decipher = createDecipheriv(
    'aes-256-cbc',
    key,
    Buffer.from(iv, 'hex')
  );

  let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}