const list = document.querySelector('#summaries');
const status = document.querySelector('#summaryStatus');
const query = new URL(location.href).searchParams;
const url = new URL('api/summary', document.baseURI);
for (const key of ['session', 'flow', 'instance']) if (query.has(key)) url.searchParams.set(key, query.get(key));
let last = '';
let stopped = false;
let timer;
async function load() {
    try {
        const response = await fetch(url, { credentials: 'include', cache: 'no-store' });
        if (!response.ok) throw new Error(`Could not load summaries (${response.status}).`);
        const { summaries, active } = await response.json();
        const signature = JSON.stringify(summaries);
        if (signature !== last) {
            list.replaceChildren(...summaries.map(({ text }) => {
                const item = document.createElement('li');
                item.textContent = text;
                return item;
            }));
            last = signature;
        }
        status.textContent = summaries.length ? (active ? 'Running…' : '') : 'No summaries yet.';
    } catch (error) { status.textContent = error.message; }
    finally { if (!stopped) timer = setTimeout(() => { if (document.hidden) schedule(); else void load(); }, 2000); }
}
function schedule() { if (!stopped) timer = setTimeout(() => { if (document.hidden) schedule(); else void load(); }, 2000); }
window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); });
window.addEventListener('pageshow', event => { if (event.persisted) { stopped = false; void load(); } });
void load();
