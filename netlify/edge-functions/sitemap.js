// Serves /sitemap.xml, built fresh from the database on every request.
//
// A file checked into the repo would be stale the moment anyone created a
// group, and nobody would notice for weeks. Reading the same view the link
// previews use means the sitemap can never disagree with what is actually
// public: group_previews already excludes anything unapproved or hidden.

const SUPABASE_URL = 'https://wtioqxzlaxgpcjhggkhg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_QHi1YKpSB5j6FlW7jOgyrw_PBcjEAS8';
const SITE = 'https://joinin.today';

// Google caps a single sitemap at 50,000 URLs. Asheville will not reach
// that, but the limit is here so the file cannot silently go invalid.
const MAX_URLS = 20000;

export function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Postgres hands back "2026-08-05 21:33:44.778632+00", which is not valid
// ISO 8601. The space has to become a T and the offset needs its minutes.
export function toISODate(v) {
  if (!v) { return ''; }
  const s = String(v).trim()
    .replace(' ', 'T')
    .replace(/([+-]\d{2})$/, '$1:00');
  const d = new Date(s);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

// Events stop being worth crawling once they are over; groups and classes
// carry on. Anything without a usable date is kept rather than guessed at.
export function isWorthListing(row, now) {
  if (row.kind !== 'event') { return true; }
  if (!row.meeting_datetime) { return true; }
  const s = String(row.meeting_datetime).trim()
    .replace(' ', 'T')
    .replace(/([+-]\d{2})$/, '$1:00');
  const d = new Date(s);
  if (isNaN(d.getTime())) { return true; }
  // One day of grace, so an event is still crawlable the morning after.
  return d.getTime() > now - 86400000;
}

export function buildSitemap(rows, now) {
  const today = new Date(now).toISOString().slice(0, 10);
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
          + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

  // The home page carries the highest weight and changes most often.
  xml += '  <url>\n'
       + '    <loc>' + SITE + '/</loc>\n'
       + '    <lastmod>' + today + '</lastmod>\n'
       + '    <changefreq>daily</changefreq>\n'
       + '    <priority>1.0</priority>\n'
       + '  </url>\n';

  let count = 0;
  for (const row of rows) {
    if (!row || !row.slug) { continue; }
    if (!isWorthListing(row, now)) { continue; }
    if (count >= MAX_URLS) { break; }
    count++;
    const mod = toISODate(row.updated_at);
    xml += '  <url>\n'
         + '    <loc>' + SITE + '/g/' + esc(row.slug) + '</loc>\n'
         + (mod ? '    <lastmod>' + mod + '</lastmod>\n' : '')
         + '    <changefreq>' + (row.kind === 'event' ? 'daily' : 'weekly') + '</changefreq>\n'
         + '    <priority>0.8</priority>\n'
         + '  </url>\n';
  }

  xml += '</urlset>\n';
  return xml;
}

async function loadRows() {
  const url = SUPABASE_URL + '/rest/v1/group_previews'
    + '?select=slug,kind,updated_at,meeting_datetime'
    + '&order=updated_at.desc'
    + '&limit=' + MAX_URLS;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
  });
  if (!res.ok) { return []; }
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

export default async () => {
  let rows = [];
  try {
    rows = await loadRows();
  } catch (err) {
    // A database hiccup should cost the listings, never the whole file.
    // A sitemap holding just the home page still validates.
    console.log('sitemap lookup failed', String(err));
  }

  return new Response(buildSitemap(rows, Date.now()), {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600'
    }
  });
};

export const config = { path: '/sitemap.xml' };
