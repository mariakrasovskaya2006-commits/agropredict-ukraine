import {readFile,writeFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const html=await readFile(new URL('demo.html',root),'utf8');
await writeFile(new URL('page.js',root),'export default '+JSON.stringify(html)+';\n');
console.log('Demo page built.');
