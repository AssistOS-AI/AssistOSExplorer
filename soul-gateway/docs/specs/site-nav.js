/* Soul Gateway documentation site navigation injector.
   Adapted from the CNL Programming Language docs pattern. */

function computeDocsRoot() {
    var script =
        document.currentScript ||
        document.querySelector('script[src*="site-nav"]');
    if (script && script.src) {
        var url = new URL(script.src, window.location.href);
        return url.href.replace(/site-nav\.js(?:\?.*)?$/, '');
    }
    var rawPath = String(window.location.pathname || '').replace(/\\/g, '/');
    var idx = rawPath.lastIndexOf('/docs/');
    var rel =
        idx >= 0
            ? rawPath.slice(idx + '/docs/'.length)
            : rawPath.replace(/^\/+/, '');
    var parts = rel.split('/').filter(Boolean);
    var depth = Math.max(0, parts.length - 1);
    return '../'.repeat(depth);
}

function joinRoot(root, href) {
    if (!root) return href;
    if (root.endsWith('/')) return root + href;
    return root + '/' + href;
}

function normalizeForCompare(href) {
    try {
        var u = new URL(href, window.location.href);
        return u.pathname.replace(/\\/g, '/').replace(/\/index\.html$/, '/');
    } catch (e) {
        return href;
    }
}

function isActiveLink(linkHref, section) {
    var here = normalizeForCompare(window.location.href);
    var target = normalizeForCompare(linkHref);
    if (here === target) return true;
    if (section && here.indexOf('/' + section + '/') >= 0) return true;
    return false;
}

function buildNav(root) {
    var nav = document.createElement('nav');
    nav.className = 'nav';

    var links = [['Specifications', 'index.html', 'specs']];

    for (var i = 0; i < links.length; i++) {
        var label = links[i][0];
        var href = links[i][1];
        var section = links[i][2];
        var a = document.createElement('a');
        a.textContent = label;
        a.href = joinRoot(root, href);
        if (isActiveLink(a.href, section)) a.className = 'active';
        nav.appendChild(a);
        if (i < links.length - 1) {
            nav.appendChild(document.createTextNode(' \u00b7 '));
        }
    }
    return nav;
}

function injectHeaderNav() {
    var header = document.querySelector('.site-header');
    if (!header || header.querySelector('.nav')) return;

    var root = computeDocsRoot();
    var row = document.createElement('div');
    row.style.marginTop = '0.75rem';
    row.appendChild(buildNav(root));
    header.querySelector('.header-inner').appendChild(row);
}

function injectFooter() {
    var existing = document.querySelector('footer.site-footer');
    if (existing) return;

    var main = document.querySelector('main');
    if (!main) return;

    var footer = document.createElement('footer');
    footer.className = 'site-footer';
    footer.innerHTML =
        '<div class="footer-inner">' +
        '<p>Research conducted by <a href="https://www.axiologic.net">Axiologic Research</a> ' +
        'as part of the European research project <a href="https://www.achilles-project.eu/">Achilles</a>.</p>' +
        '<p><strong>Disclaimer:</strong> This documentation was generated with AI assistance and may contain errors. ' +
        'The system is open source \u2014 verify claims by examining the source code.</p>' +
        '</div>';

    main.parentNode.insertBefore(footer, main.nextSibling);
}

try {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            injectHeaderNav();
            injectFooter();
        });
    } else {
        injectHeaderNav();
        injectFooter();
    }
} catch (e) {
    /* ignore */
}
