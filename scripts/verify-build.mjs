import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import assert from 'node:assert/strict';
import config from '../astro.config.mjs';

// Base de publicación (raíz en GitHub Pages de usuario); los enlaces absolutos la incluyen.
const base = config.base ?? '/';

const root = resolve('dist');
const list = async (dir) => (await Promise.all((await readdir(dir)).map(async (name) => {
  const path = join(dir, name);
  return (await stat(path)).isDirectory() ? list(path) : [path];
}))).flat();
const files = await list(root);
const pages = files.filter((file) => file.endsWith('.html'));
const notFound = join(root, '404.html');
const documents = new Map(await Promise.all(pages.map(async (file) => [file, await readFile(file, 'utf8')])));
const ids = (html) => [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const titles = new Set();
const canonicals = new Set();
const attr = (html, pattern) => html.match(pattern)?.[1];
for (const [file, html] of documents) {
  const name = relative(root, file);
  assert.equal((html.match(/<h1\b/g) || []).length, 1, `${name}: un solo H1`);
  assert.equal(ids(html).length, new Set(ids(html)).size, `${name}: IDs únicos`);
  // JavaScript propio en módulos: en todas las páginas, el que une correo y teléfono
  // del contacto; además, el filtro en la portada y la ficha flotante en los casos.
  // El único script externo admitido es el de métricas de Umami, una vez por página.
  const umami = '<script defer src="https://cloud.umami.is/script.js" data-website-id="06478f4f-6280-4052-8fbd-3644fae8804a" data-domains="zabrinnavargas.github.io"></script>';
  assert.equal(html.split(umami).length - 1, 1, `${name}: script de Umami`);
  const scripts = [...html.replace(umami, '').matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
  const expected = name === 'index.html' || name.startsWith('proyectos/') ? 2 : 1;
  // Direcciones limpias: los enlaces internos no terminan en .html.
  for (const [, href] of html.matchAll(/<a\b[^>]*\bhref="(\/[^"]*)"/g)) assert(!/\.html(#|$)/.test(href), `${name}: enlace interno sin .html (${href})`);
  assert.equal(scripts.length, expected, `${name}: ${expected} scripts propios`);
  for (const script of scripts) assert(/type="module"/.test(script) && !/src="https?:/.test(script), `${name}: script propio de tipo módulo`);
  // Contacto protegido: ni correo completo ni teléfono legible por robots en el HTML.
  assert(!/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(html) && !/href="(mailto|tel):|615 ?689 ?016/.test(html), `${name}: correo y teléfono ocultos en el HTML`);
  assert(/data-contact="email"/.test(html) && /data-contact="tel"/.test(html), `${name}: contacto presente`);
  assert(html.includes('<html lang="es">'), `${name}: idioma español`);
  assert(/<meta name="description" content="[^"]+"/.test(html), `${name}: descripción SEO`);
  const title = html.match(/<title>(.*?)<\/title>/)?.[1];
  assert(title && !titles.has(title), `${name}: título único`);
  titles.add(title);
  const canonical = attr(html, /<link rel="canonical" href="([^"]+)"/);
  assert(canonical && /^https:\/\//.test(canonical) && !canonicals.has(canonical), `${name}: URL canónica absoluta y única`);
  canonicals.add(canonical);
  assert.equal(attr(html, /<meta property="og:url" content="([^"]+)"/), canonical, `${name}: og:url igual a la canónica`);
  const image = attr(html, /<meta property="og:image" content="([^"]+)"/);
  const card = attr(html, /<meta name="twitter:card" content="([^"]+)"/);
  assert.equal(card, image ? 'summary_large_image' : 'summary', `${name}: twitter:card acorde a la imagen`);
  if (image) {
    assert(image.startsWith(new URL(canonical).origin), `${name}: og:image en el propio sitio`);
    assert(files.includes(join(root, decodeURIComponent(new URL(image).pathname.slice(base.length)))), `${name}: existe og:image`);
  }
  for (const [, attribute, value] of html.matchAll(/\b(href|src)="([^"]*)"/g)) {
    const url = new URL(value.replaceAll('&amp;', '&'), `https://portfolio.invalid/${name}`);
    if (url.origin !== 'https://portfolio.invalid') continue;
    if (value.startsWith('/')) assert(value.startsWith(base), `${name}: ${attribute} ${value} incluye la base ${base}`);
    const target = decodeURIComponent(value.startsWith('/') ? `/${url.pathname.slice(base.length)}` : url.pathname);
    const destination = join(root, target.endsWith('/') ? `${target}index.html` : target);
    assert(files.includes(destination), `${name}: destino de ${attribute} ${value}`);
    if (url.hash) assert(ids(documents.get(destination) || '').includes(decodeURIComponent(url.hash.slice(1))), `${name}: ancla ${value}`);
  }
  // Los enlaces que salen del portfolio se abren en una pestaña nueva.
  for (const [tag, href] of html.matchAll(/<a\b[^>]*\bhref="(https?:[^"]*)"[^>]*>/g)) {
    assert(tag.includes('target="_blank"') && /rel="[^"]*noopener/.test(tag), `${name}: ${href} se abre en pestaña nueva`);
  }
}
const home = documents.get(join(root, 'index.html'));
assert(home, 'Existe el inicio');
const projectFiles = (await readdir('src/content/projects')).filter((file) => file.endsWith('.md'));
assert.equal(pages.length, projectFiles.length + 2, 'Una página por proyecto, el inicio y la 404');
assert(documents.get(notFound)?.includes('<meta name="robots" content="noindex"'), 'La 404 no se indexa');
const sitemap = await readFile(join(root, 'sitemap.xml'), 'utf8');
assert.equal((sitemap.match(/<loc>/g) || []).length, projectFiles.length + 1, 'El mapa del sitio lista el inicio y cada caso');
assert((await readFile(join(root, 'robots.txt'), 'utf8')).includes(`Sitemap: ${new URL('sitemap.xml', new URL(base, config.site)).href}`), 'robots.txt enlaza el mapa del sitio');
assert.equal((home.match(/class="project-card(?: featured)?"/g) || []).length, projectFiles.length, 'Una tarjeta por proyecto');
assert(home.includes('data-filter-status'), 'El filtro anuncia los resultados');
// Filtros y proyectos deben corresponderse: cada área ofrecida muestra algún proyecto y cada área
// de un proyecto, incluido el destacado, tiene su filtro.
const filterIds = [...home.matchAll(/id="f-([^"]+)"/g)].map((match) => match[1]).filter((id) => id !== 'todos');
const cardAreas = [...home.matchAll(/<article class="project-card(?: featured)?" data-areas="([^"]*)"/g)]
  .map(([, list]) => ({ areas: list.split(' ') }));
assert.equal(cardAreas.length, projectFiles.length, 'Cada tarjeta declara sus áreas');
for (const id of filterIds) assert(cardAreas.some(({ areas }) => areas.includes(id)), `Filtro ${id}: muestra al menos un proyecto`);
for (const { areas } of cardAreas) for (const id of areas) assert(filterIds.includes(id), `Área ${id}: tiene filtro`);
const nextLinks = new Map();
for (const file of projectFiles) {
  const slug = file.slice(0, -3);
  const path = join(root, 'proyectos', slug, 'index.html');
  const html = documents.get(path);
  assert(html, `Se conserva la URL de ${slug}`);
  assert(html.includes('class="case-step"'), `${slug}: relato renderizado`);
  const nav = html.match(/<nav class="project-pagination wrap"[\s\S]*?<\/nav>/)?.[0];
  const links = [...(nav || '').matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  assert(links.includes(`${base}#proyectos`), `${slug}: volver al índice`);
  const next = links.find((link) => link.startsWith(`${base}proyectos/`));
  assert(next && next !== `${base}proyectos/${slug}/`, `${slug}: siguiente distinto`);
  nextLinks.set(`${base}proyectos/${slug}/`, next);
  assert(sitemap.includes(`<loc>${new URL(`proyectos/${slug}/`, config.site).href}</loc>`), `${slug}: en el mapa del sitio`);
}
let current = nextLinks.keys().next().value;
const visited = new Set();
while (!visited.has(current)) { visited.add(current); current = nextLinks.get(current); }
assert.equal(visited.size, projectFiles.length, 'Navegación circular por todos los proyectos');
const pending = [];
if (![...documents.values()].some((html) => html.includes('property="og:image"'))) pending.push('sin imagen para compartir (og:image)');
if (pending.length) console.warn(`PENDIENTE antes de publicar: ${pending.join('; ')} (ver docs/ANTES-DE-PUBLICAR.md).`);
console.log(`OK: ${pages.length} páginas (con la 404); direcciones sin .html; mapa del sitio y robots.txt; enlaces y recursos; anclas; enlaces externos en pestaña nueva; filtros y áreas; SEO y metadatos para compartir; contenido renderizado; navegación circular; JavaScript solo en el contacto, el filtro de la portada, la ficha de los casos y las métricas de Umami; correo y teléfono ocultos.`);
