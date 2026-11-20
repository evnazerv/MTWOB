/**
 * End-to-end UI check: boots the simulated backend (gas-backend/dev/serve.js --demo), launches the
 * real Electron app with Playwright, connects through the Settings wizard and walks every view.
 *   node scripts/e2e.js [screenshot-dir]        (Linux CI: xvfb-run -a node scripts/e2e.js)
 * Requires the `playwright` package to be resolvable. Native dialogs are auto-confirmed.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { spawn } = require('child_process');
const { _electron } = require('playwright');

const appDir = path.join(__dirname, '..');
const shots = process.argv[2] || path.join(os.tmpdir(), 'nt-e2e');
fs.mkdirSync(shots, { recursive: true });

(async () => {
  const server = spawn(process.execPath, [path.join(appDir, '..', 'gas-backend', 'dev', 'serve.js'), '--demo'], { env: { ...process.env, PORT: '8799' } });
  const token = await new Promise((resolve, reject) => {
    let out = '';
    server.stdout.on('data', (d) => { out += d; const m = out.match(/Handshake token:\s+(\w+)/); if (m) resolve(m[1]); });
    server.on('exit', () => reject(new Error('backend exited: ' + out)));
  });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-user-'));
  const app = await _electron.launch({ executablePath: require(path.join(appDir, 'node_modules', 'electron')), args: [appDir, '--no-sandbox', '--user-data-dir=' + userData], colorScheme: process.env.SCHEME || 'light' });
  const errors = [];
  let step = 'boot';
  try {
    // Auto-confirm native dialogs (kill switch confirmation) and silence save dialogs.
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); dialog.showErrorBox = () => {}; });
    const page = await app.firstWindow();
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.setViewportSize({ width: 1360, height: 880 });
    const shot = (name) => page.screenshot({ path: path.join(shots, name + '.png') });
    const nav = (view) => page.click(`.nav-item[data-view="${view}"]`);

    step = 'connect';
    await page.waitForSelector('text=Step 1 · Connect');
    assert.ok(await page.isDisabled('#kill-switch'), 'kill switch disabled before connecting');
    await shot('01-setup');
    await page.fill('input[type=url]', 'http://127.0.0.1:8799/exec');
    await page.fill('input[type=password]', 'wrong-token');
    await page.click('text=Save & Test Connection');
    await page.waitForSelector('.test-result.bad');
    await page.fill('input[type=password]', token);
    await page.click('text=Save & Test Connection');
    await page.waitForSelector('text=Step 2 · Claude AI');
    await page.waitForSelector('.pill.running');
    assert.match(await page.textContent('#trigger-text'), /RUNNING · 4 triggers/);
    await shot('02-wizard-claude');
    await page.click('text=Save & Test');
    await page.waitForSelector('.test-result.ok');
    await page.click('.step:nth-child(3)');
    await page.waitForSelector('legend:has-text("Wix Blog")');
    await shot('03-wizard-cms');

    step = 'dashboard';
    await nav('dashboard');
    await page.waitForSelector('#ch-trend');
    await page.waitForTimeout(700);
    assert.strictEqual(await page.locator('.kpi').count(), 8);
    for (const id of ['ch-trend', 'ch-metros', 'ch-channels', 'ch-costs', 'ch-rel']) assert.ok(await page.locator('#' + id).count(), 'chart ' + id);
    await shot('04-dashboard');
    await page.evaluate(() => document.querySelector('#main').scrollTo(0, 99999));
    await page.waitForTimeout(300);
    await shot('05-dashboard-lower');

    step = 'tools';
    await nav('tools');
    await page.waitForSelector('.tool');
    assert.ok((await page.locator('.tool').count()) >= 12);
    await shot('06-tools');
    const fb = page.locator('.tool', { hasText: 'TOGGLE_TIKTOK' });
    await fb.locator('input').check();
    await page.waitForSelector('.tool:has-text("TOGGLE_TIKTOK") .tag.warn'); // enabled without credentials → Missing API Key
    await page.locator('.tool', { hasText: 'TOGGLE_TIKTOK' }).locator('input').uncheck();
    await page.waitForSelector('.tool.off:has-text("TOGGLE_TIKTOK")');

    step = 'agent';
    await nav('agent');
    await page.waitForSelector('text=Workflow mode');
    await shot('07-agent');
    await page.click('text=Autonomous Mode');
    await page.click('text=Save changes');
    await page.waitForSelector('#mode-pill:has-text("Autonomous")');
    await page.click('text=Human-in-the-Loop Approval');
    await page.click('text=Save changes');
    await page.waitForSelector('#mode-pill:has-text("Approval")');

    step = 'studio';
    await nav('studio');
    await page.waitForSelector('.q-item');
    await page.selectOption('select[aria-label="Status filter"]', 'review');
    await page.locator('.q-item', { hasText: 'Blog' }).first().click();
    await page.waitForSelector('iframe.blog-preview');
    const frame = page.frameLocator('iframe.blog-preview');
    await frame.locator('h1').waitFor();
    assert.ok((await frame.locator('h2').count()) >= 2, 'blog HTML rendered in sandboxed preview');
    await shot('08-studio-blog');
    await page.click('text=SEO meta & slug');
    await page.fill('.field:has-text("SEO title") input', 'Edited Title for Tampa Telehealth');
    assert.strictEqual(await page.textContent('#serp-title'), 'Edited Title for Tampa Telehealth');
    await page.click('#save-edits');
    await page.waitForSelector('h1:has-text("Edited Title for Tampa Telehealth")');
    await shot('09-studio-seo');
    await page.click('text=Publish Now to NodeTelehealth.com');
    await page.waitForSelector('.toast:has-text("Published")');
    await page.selectOption('select[aria-label="Status filter"]', 'review');
    await page.locator('.q-item', { hasText: 'Video' }).first().click();
    await page.waitForSelector('#video-slot');
    await shot('10-studio-video-script');
    await page.click('text=Approve Script & Render Video');
    await page.waitForSelector('.detail .tag:has-text("Rendering")');

    step = 'kill switch';
    await page.click('#kill-switch');
    await page.waitForSelector('#kill-switch[aria-checked="true"]');
    await page.waitForSelector('#halt-banner:visible');
    assert.match(await page.textContent('#trigger-text'), /HARD STOPPED/);
    await nav('tools');
    await page.waitForSelector('.tool .tag.danger');
    await shot('11-halted-tools');
    await nav('agent');
    await page.waitForSelector('text=Run now');
    assert.ok(await page.isDisabled('button:has-text("Generate content")'), 'run-now disabled while halted');
    const blocked = await page.evaluate(() => window.nt.call('runGenerateNow'));
    assert.strictEqual(blocked.status, 423);
    assert.strictEqual(blocked.code, 'SYSTEM_HALTED');
    const tray = await app.evaluate(() => 'ok'); assert.strictEqual(tray, 'ok');
    await page.click('#kill-switch');
    await page.waitForSelector('#kill-switch[aria-checked="false"]');
    await page.waitForSelector('.pill.running');
    assert.match(await page.textContent('#trigger-text'), /RUNNING · 4 triggers/);

    step = 'done';
    assert.deepStrictEqual(errors, [], 'no renderer errors');
    console.log('E2E passed. Screenshots in ' + shots);
  } catch (err) {
    console.error('E2E FAILED at step "' + step + '":', err.message, '\nRenderer errors:', errors);
    try { const p = await app.firstWindow(); await p.screenshot({ path: path.join(shots, 'failure.png') }); } catch (e) { /* ignore */ }
    process.exitCode = 1;
  } finally {
    await app.close().catch(() => {});
    server.kill();
  }
})();
