import { chromium } from 'playwright';
import { ensureDir, writeJson, writeText } from './paths.mjs';
import { dirname, join } from 'path';

export async function launchBrowser({ headed = true, storageState } = {}) {
  const browser = await chromium.launch({
    headless: !headed,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled', '--disable-infobars']
  });
  const context = await browser.newContext(storageState ? { storageState } : {});
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  const page = await context.newPage();
  return { browser, context, page };
}

export async function discoverPage(page) {
  return await page.evaluate(() => {
    const labelTextFor = element => {
      const labels = [];
      if (element.labels) {
        for (const label of element.labels) labels.push((label.innerText || '').trim());
      }
      const id = element.id;
      if (id) {
        document.querySelectorAll(`label[for="${CSS.escape(id)}"]`).forEach(label => labels.push((label.innerText || '').trim()));
      }
      return [...new Set(labels.filter(Boolean))].join('; ');
    };
    const visible = element => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const inputInfo = (el, index) => ({
      index,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      id: el.id || '',
      name: el.getAttribute('name') || '',
      placeholder: el.getAttribute('placeholder') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      labels: labelTextFor(el),
      visible: visible(el),
      accept: el.getAttribute('accept') || ''
    });
    const buttonInfo = (el, index) => ({
      index,
      text: (el.innerText || el.value || '').trim(),
      id: el.id || '',
      name: el.getAttribute('name') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      visible: visible(el)
    });
    return {
      url: location.href,
      captured_at: new Date().toISOString(),
      inputs: Array.from(document.querySelectorAll('input')).map(inputInfo),
      textareas: Array.from(document.querySelectorAll('textarea')).map(inputInfo),
      selects: Array.from(document.querySelectorAll('select')).map(inputInfo),
      buttons: Array.from(document.querySelectorAll('button,input[type="button"],input[type="submit"]')).map(buttonInfo),
      fileInputs: Array.from(document.querySelectorAll('input[type="file"]')).map(inputInfo)
    };
  });
}

function mdTable(rows, columns) {
  const head = '| ' + columns.join(' | ') + ' |';
  const sep = '| ' + columns.map(() => '---').join(' | ') + ' |';
  const body = rows.map(row => '| ' + columns.map(col => String(row[col] ?? '').replace(/\n/g, ' ').slice(0, 400)).join(' | ') + ' |');
  return [head, sep, ...body].join('\n');
}

export function discoveryMarkdown(discovery) {
  return [
    '# Browsy Field Discovery',
    '',
    `URL: ${discovery.url}`,
    `Captured: ${discovery.captured_at}`,
    '',
    '## Inputs',
    '',
    mdTable(discovery.inputs, ['index','type','id','name','placeholder','ariaLabel','labels','visible','accept']),
    '',
    '## Textareas',
    '',
    discovery.textareas.length ? mdTable(discovery.textareas, ['index','id','name','placeholder','labels','visible']) : 'None',
    '',
    '## Selects',
    '',
    discovery.selects.length ? mdTable(discovery.selects, ['index','id','name','ariaLabel','labels','visible']) : 'None',
    '',
    '## Buttons',
    '',
    discovery.buttons.length ? mdTable(discovery.buttons, ['index','text','id','name','ariaLabel','visible']) : 'None',
    '',
    '## File Inputs',
    '',
    discovery.fileInputs.length ? mdTable(discovery.fileInputs, ['index','id','name','accept','ariaLabel','labels','visible']) : 'None',
    ''
  ].join('\n');
}

export async function writeDiscoveryArtifacts(page, runDir) {
  ensureDir(runDir);
  const discovery = await discoverPage(page);
  writeJson(join(runDir, 'discovered-fields.json'), discovery);
  writeText(join(runDir, 'discovered-fields.md'), discoveryMarkdown(discovery));
  await page.screenshot({ path: join(runDir, 'screenshot-discovery.png'), fullPage: true }).catch(() => {});
  writeText(join(runDir, 'page-text-snapshot.txt'), await page.locator('body').innerText().catch(() => ''));
  writeText(join(runDir, 'html-snapshot.html'), await page.content().catch(() => ''));
  return discovery;
}
