import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeFolderName } from '../src/util/safeName.js';

test('folder names are ASCII only', () => {
    assert.equal(safeFolderName('Prominence™ II Hasturian Era v4.1.6'), 'ProminenceTM_II_Hasturian_Era_v4.1.6');
    assert.equal(safeFolderName('Café: Édition, 1.0'), 'Cafe_Edition_1.0');
    assert.equal(safeFolderName('All the Mods 10 - 5.1'), 'All_the_Mods_10_-_5.1');
    assert.equal(safeFolderName('../x'), 'x');
    assert.equal(safeFolderName('★★★'), 'modpack');
});
