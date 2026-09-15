export class ConfidentialDocumentError extends Error {
  constructor(code) {
    const missing = code === 'document_not_found';
    if (!missing && code !== 'document_forbidden') {
      throw new TypeError('Unsupported Confidential document error.');
    }
    super(missing ? 'Confidential file not found.' : 'You do not have read access to this Confidential document.');
    this.name = 'ConfidentialDocumentError';
    this.code = code;
    this.statusCode = missing ? 404 : 403;
  }
}
