import { BadRequestError, PayloadTooLargeError } from './errors.mjs';

/**
 * Read the full request body and parse it as JSON.
 * Rejects bodies larger than `limitBytes`.
 */
export function readJsonBody(req, limitBytes = 5_242_880) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let bytes = 0;
        let oversized = false;

        req.on('data', (chunk) => {
            if (oversized) {
                return;
            }
            bytes += chunk.length;
            if (bytes > limitBytes) {
                oversized = true;
                chunks.length = 0;
                reject(new PayloadTooLargeError(limitBytes));
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', () => {
            if (oversized) {
                return;
            }
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

        req.on('error', (err) => {
            if (!oversized) {
                reject(err);
            }
        });
    });
}
