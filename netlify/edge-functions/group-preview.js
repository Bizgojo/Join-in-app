// Serves /g/<slug> with real link-preview and search tags baked into the
// HTML before it leaves the edge. Facebook, iMessage, Slack and Google all
// read the page without running JavaScript, so the tags have to be present
// in the first response — the app's own rendering happens far too late.
//
// The app itself is untouched: this only rewrites <title> and the meta
// block, then hands the same single-file app to the browser.

const SUPABASE_URL = 'https://wtioqxzlaxgpcjhggkhg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_QHi1YKpSB5j6FlW7jOgyrw_PBcjEAS8';
const SITE = 'https://joinin.today';

const FIELDS = [
  'slug', 'kind', 'name', 'description', 'category', 'cover_image',
  'location', 'venue_name', 'instructor', 'meeting_datetime',
  'member_count', 'is_paid', 'price'
].join(',');

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Preview text is truncated on a word boundary so descriptions never end
// mid-word in a Facebook card.
function clip(v, max) {
  const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  if (t.length <= max) { return t; }
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut) + '\u2026';
}

// Postgres returns "2026-08-07 10:30:00+00". That is not valid ISO 8601 —
// the space needs to be a T and the offset needs its minutes — so it has
// to be normalised before schema.org will accept it.
function toISO(v) {
  if (!v) { return ''; }
  const s = String(v).trim()
    .replace(' ', 'T')
    .replace(/([+-]\d{2})$/, '$1:00');
  const d = new Date(s);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

async function loadItem(slug) {
  const url = SUPABASE_URL + '/rest/v1/group_previews'
    + '?slug=eq.' + encodeURIComponent(slug)
    + '&select=' + FIELDS
    + '&limit=1';
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
  });
  if (!res.ok) { return null; }
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export function buildTags(item) {
  const isClass = item.kind === 'class';
  const noun = isClass ? 'Class' : 'Group';
  const where = item.location || 'Asheville, NC';
  const url = SITE + '/g/' + item.slug;

  const title = item.name + ' \u2014 ' + noun + ' in ' + where + ' | JoinIn';

  let desc = clip(item.description, 180);
  if (!desc) {
    desc = noun + ' in ' + where + ' on JoinIn.';
  }
  const bits = [];
  if (item.instructor) { bits.push('Led by ' + item.instructor); }
  if (item.venue_name) { bits.push('At ' + item.venue_name); }
  if (isClass && item.is_paid && item.price) { bits.push('$' + item.price); }
  if (!isClass && !item.is_paid) { bits.push('Free to join'); }
  if (bits.length) { desc = desc + ' \u00b7 ' + bits.join(' \u00b7 '); }

  // og:image has to be an absolute http(s) URL. Data URIs and storage
  // paths are skipped rather than shipped broken.
  const img = /^https?:\/\//.test(item.cover_image || '') ? item.cover_image : '';

  let tags = ''
    + '<meta name="description" content="' + esc(desc) + '">\n'
    + '<link rel="canonical" href="' + esc(url) + '">\n'
    + '<meta property="og:type" content="website">\n'
    + '<meta property="og:site_name" content="JoinIn">\n'
    + '<meta property="og:title" content="' + esc(item.name) + '">\n'
    + '<meta property="og:description" content="' + esc(desc) + '">\n'
    + '<meta property="og:url" content="' + esc(url) + '">\n'
    + '<meta name="twitter:card" content="'
      + (img ? 'summary_large_image' : 'summary') + '">\n'
    + '<meta name="twitter:title" content="' + esc(item.name) + '">\n'
    + '<meta name="twitter:description" content="' + esc(desc) + '">\n';

  if (img) {
    tags += '<meta property="og:image" content="' + esc(img) + '">\n'
         +  '<meta name="twitter:image" content="' + esc(img) + '">\n';
  }

  // Structured data gives Google something to show beyond a blue link.
  const ld = {
    '@context': 'https://schema.org',
    '@type': isClass ? 'Course' : 'Event',
    name: item.name,
    description: clip(item.description, 300) || undefined,
    url: url
  };
  const start = toISO(item.meeting_datetime);
  if (start) { ld.startDate = start; }
  if (item.venue_name || where) {
    ld.location = {
      '@type': 'Place',
      name: item.venue_name || where,
      address: where
    };
  }
  if (isClass) { ld.provider = { '@type': 'Organization', name: 'JoinIn' }; }

  tags += '<script type="application/ld+json">'
       + JSON.stringify(ld).replace(/</g, '\\u003c')
       + '<\/script>\n';

  return { title: title, tags: tags };
}

// Swaps the app's default title and description for this item's.
export function inject(html, item) {
  const built = buildTags(item);
  return html
    .replace(/<meta\s+name="description"[^>]*>\s*/i, '')
    .replace(
      /<title>[\s\S]*?<\/title>/i,
      '<title>' + esc(built.title) + '</title>\n' + built.tags
    );
}

export default async (request, context) => {
  const response = await context.next();

  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) { return response; }

  const slug = String((context.params && context.params.slug) || '')
    .toLowerCase();
  if (!slug) { return response; }

  const html = await response.text();

  let item = null;
  try {
    item = await loadItem(slug);
  } catch (err) {
    // A Supabase hiccup should cost the preview, never the page.
    console.log('group-preview lookup failed', String(err));
  }

  if (!item) { return new Response(html, response); }
  return new Response(inject(html, item), response);
};

export const config = { path: '/g/:slug' };
