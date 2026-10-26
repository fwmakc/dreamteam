import { MockProvider } from './src/providers/mock.js';
const mp = new MockProvider('test');
let usage;
for await (const chunk of mp.stream({messages:[{role:'user',content:'hi'}]}, (u) => { console.log('onUsage:', JSON.stringify(u)); usage = u; })) {
  // consume
}
console.log('after:', JSON.stringify(usage));
