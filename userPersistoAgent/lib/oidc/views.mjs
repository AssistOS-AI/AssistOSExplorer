export function escapeHtml(value) {
    return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function page(title, body) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · UserPersisto</title><style>
    *{box-sizing:border-box}body{margin:0;background:#f4f6fb;color:#18253b;font:16px/1.5 system-ui,sans-serif}main{max-width:480px;margin:8vh auto;padding:32px;background:white;border:1px solid #dce3ee;border-radius:16px;box-shadow:0 12px 36px #20304c0c}h1{font-size:26px;margin:4px 0 20px}.brand{color:#526880;font-size:13px;font-weight:700;letter-spacing:.08em}label{display:block;margin:14px 0}input{font:inherit;width:100%;padding:10px;border:1px solid #adbdd1;border-radius:6px}button{font:inherit;cursor:pointer;padding:10px 16px;border:0;border-radius:6px;background:#214eb8;color:white;margin:8px 8px 0 0}button.secondary{background:#e8edf5;color:#243958}.error{color:#9f1b2c}.muted{color:#526880}code{overflow-wrap:anywhere}details{margin-top:22px;border-top:1px solid #e3e8f0;padding-top:14px}li{margin:8px 0}@media(max-width:520px){main{margin:16px;padding:24px}}
    </style></head><body><main><div class="brand">USERPERSISTO</div><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
}
