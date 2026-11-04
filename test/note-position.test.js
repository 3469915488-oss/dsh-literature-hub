import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutMarkerRows} from '../reader/notes.js';

test('right gutter separates nearby marks and groups overflow without dropping annotations',()=>{
  const points=['a','b','c'].map((id,index)=>({annotation:{id},y:510+index}));
  const rows=layoutMarkerRows(points,560);
  assert.equal(rows.length,3);
  assert.ok(rows[0].top>=5);
  assert.ok(rows[2].top+24<=555);
  assert.ok(rows[1].top-rows[0].top>=28);
  assert.ok(rows[2].top-rows[1].top>=28);
  const packed=layoutMarkerRows(points,70);
  assert.deepEqual(packed.flatMap(row=>row.items.map(item=>item.id)),['a','b','c']);
  assert.ok(packed.every(row=>row.top>=5&&row.top+24<=65));
});
