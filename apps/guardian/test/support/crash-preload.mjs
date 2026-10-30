// Test-only preload (`node --import <this file> --import tsx src/main.ts`): throws an uncaught exception
// right after the guardian logs `guardian.started`, the way a library bug in a callback would.
const write = process.stdout.write.bind(process.stdout);
let thrown = false;
process.stdout.write = (chunk, ...rest) => {
  const r = write(chunk, ...rest);
  if (!thrown && String(chunk).includes('guardian.started')) {
    thrown = true;
    setTimeout(() => {
      throw new Error('test crash after start');
    }, 50);
  }
  return r;
};
