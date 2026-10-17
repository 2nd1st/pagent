// The page's language, as the browser is told it (<html lang>: fonts, line breaking, quotes, what a screen reader
// speaks): the one the page says it is in (metadata.lang), else the app's (its home page's), else the reader's.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { testApp, type TestApp } from "../lib/app.ts";
import { buildShell } from "../lib/shell.ts";

const page = (title: string, lang?: string) =>
  `export const metadata = ${JSON.stringify({ title, ...(lang ? { lang } : {}) })};\nexport default function P() { return <p>${title}</p>; }\n`;

describe("<html lang>", () => {
  let zh: TestApp;
  let plain: TestApp;
  let browser: Browser;
  before(async () => {
    buildShell();
    [zh, plain] = await Promise.all([
      testApp({ "page.tsx": page("首页", "zh-CN"), "en/page.tsx": page("English", "en"), "other/page.tsx": page("其他") }),
      testApp({ "page.tsx": page("Home") }),
    ]);
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await Promise.all([zh?.close(), plain?.close()]);
  });

  /** The lang the page at `url` ends up with, waiting a little for `expected` (the pages come after the first paint). */
  const langAt = async (url: string, text: string, expected: string) => {
    const p = await browser.newPage({ locale: "fr-FR" });
    await p.goto(url);
    await p.getByText(text).first().waitFor();
    await p.waitForFunction((l) => document.documentElement.lang === l, expected, { timeout: 5000 }).catch(() => {});
    const lang = await p.evaluate(() => document.documentElement.lang);
    await p.close();
    return lang;
  };

  test("the app's, as its home page says it", async () => {
    assert.equal(await langAt(zh.url + "/", "首页", "zh-CN"), "zh-CN");
    assert.equal(await langAt(zh.url + "/other", "其他", "zh-CN"), "zh-CN", "a page that says none: the app's");
  });

  test("a page that says its own: that one", async () => {
    assert.equal(await langAt(zh.url + "/en", "English", "en"), "en");
  });

  test("an app that says none: the reader's", async () => {
    assert.equal(await langAt(plain.url + "/", "Home", "fr-FR"), "fr-FR");
  });
});
