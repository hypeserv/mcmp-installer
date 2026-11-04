import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLoaderCompatFixes, compareVersions } from '../src/installLoader.js';

test('compareVersions', () => {
    assert.ok(compareVersions('36.2.20', '36.2.26') < 0);
    assert.ok(compareVersions('36.2.34', '36.2.26') > 0);
    assert.equal(compareVersions('14.23.5.2860', '14.23.5.2860'), 0);
    assert.ok(compareVersions('47.4.10', '47.4.9') > 0);
});

test('Forge 1.16.5 before 36.2.26 is replaced; other versions untouched', () => {
    assert.equal(applyLoaderCompatFixes({ kind: 'forge', mcVersion: '1.16.5', loaderVersion: '36.2.20' }).loaderVersion, '36.2.34');
    assert.equal(applyLoaderCompatFixes({ kind: 'forge', mcVersion: '1.16.5', loaderVersion: '36.2.39' }).loaderVersion, '36.2.39');
    assert.equal(applyLoaderCompatFixes({ kind: 'forge', mcVersion: '1.12.2', loaderVersion: '14.23.5.2860' }).loaderVersion, '14.23.5.2860');
    assert.equal(applyLoaderCompatFixes({ kind: 'neoforge', mcVersion: '1.21.1', loaderVersion: '21.1.1' }).loaderVersion, '21.1.1');
});
