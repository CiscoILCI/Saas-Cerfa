const fs = require('fs');

async function extractNotice() {
  try {
    const pdfParse = (await import('pdf-parse')).default;
    const dataBuffer = fs.readFileSync('notice_51649#09.pdf');
    const data = await pdfParse(dataBuffer);
    
    fs.writeFileSync('notice_content.txt', data.text);
    console.log('Notice extraite dans notice_content.txt');
    console.log('Nombre de pages:', data.numpages);
  } catch (e) {
    console.error('Erreur:', e.message);
  }
}

extractNotice();
