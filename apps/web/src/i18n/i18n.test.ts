import assert from 'node:assert/strict';
import { test } from 'node:test';
import { en } from './en';
import { fr } from './fr';
import { rw } from './rw';
import { langOf, pickLang, rwAgo, topicName, translator } from './index';

test('the language comes from the switcher, then the account, then the browser; English otherwise', () => {
  assert.equal(pickLang('fr', 'rw', 'en-US'), 'fr');
  assert.equal(pickLang(undefined, 'rw', 'en-US'), 'rw');
  assert.equal(pickLang('xx', 'de', 'de-DE,rw;q=0.9,en;q=0.8'), 'rw');
  assert.equal(pickLang(undefined, null, 'fr-RW,fr;q=0.9'), 'fr');
  assert.equal(pickLang(undefined, null, 'de-DE'), 'en');
  assert.equal(langOf('rw-RW'), 'rw');
  assert.equal(langOf('pt-BR'), 'en');
});

test('translations fill in values and fall back to English for anything not translated', () => {
  const t = translator('rw');
  assert.equal(t('home.left', { time: '3:20' }), 'hasigaye 3:20');
  assert.equal(translator('fr')('video.views.other', { count: '48 k' }), '48 k vues');
  // A key without a Kinyarwanda text shows the English one.
  const missing = (Object.keys(en) as Array<keyof typeof en>).find((k) => !(k in rw));
  if (missing) assert.equal(t(missing), en[missing]);
});

test('every translation uses the same {placeholders} as the English text', () => {
  const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const [name, dict] of [['rw', rw], ['fr', fr]] as const) {
    for (const [key, text] of Object.entries(dict)) {
      assert.equal(vars(text!), vars(en[key as keyof typeof en]), `${name} ${key}`);
    }
  }
});

test('Kinyarwanda relative time, and topic names with the stored name for new topics', () => {
  assert.equal(rwAgo(-3, 'day'), 'hashize iminsi 3');
  assert.equal(rwAgo(-1, 'hour'), 'hashize isaha 1');
  assert.equal(rwAgo(-2, 'week'), 'hashize ibyumweru 2');
  assert.equal(topicName(translator('rw'), 'music', 'Music'), 'Umuziki');
  assert.equal(topicName(translator('fr'), 'brand-new-topic', 'Brand New'), 'Brand New');
});
