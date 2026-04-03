import { BadRequestError } from './errors.mjs';

/**
 * Read the full request body and parse it as JSON.
 * Rejects bodies larger than `limitBytes`.
 */
export function readJsonBody(req, limitBytes = 5_242_880) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;

    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > limitBytes) {
        req.destroy();
        reject(new BadRequestError(`Request body exceeds ${limitBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (bytes === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new BadRequestError('Invalid JSON in request body'));
      }
    });

    req.on('error', (err) => reject(err));
  });
}
