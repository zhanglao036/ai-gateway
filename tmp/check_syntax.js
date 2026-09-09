const fs = require('fs');

const fileContent = fs.readFileSync('src/pages.ts', 'utf8');

// Find all <script> ... </script> blocks in pages.ts
const scriptMatches = fileContent.match(/<script[\s\S]*?<\/script>/g);
console.log('Found script blocks count:', scriptMatches ? scriptMatches.length : 0);

if (scriptMatches) {
  scriptMatches.forEach((s, idx) => {
    let code = s.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
    // replace ${...} with dummy expressions
    code = code.replace(/\${[\s\S]*?}/g, '"dummy"');
    try {
      new Function(code);
      console.log('Script block ' + idx + ': OK');
    } catch (e) {
      console.error('Script block ' + idx + ' ERROR:', e.message);
      // print line around error
      console.log('Code sample around error:');
      console.log(code.slice(0, 1000));
    }
  });
}
