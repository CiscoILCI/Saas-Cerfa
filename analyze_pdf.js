const { PDFDocument } = require('pdf-lib');
const fs = require('fs');

async function analyzePdf() {
  try {
    const pdfBytes = fs.readFileSync('cerfa_ apprentissage_10103-14.pdf');
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const form = pdfDoc.getForm();
    const fields = form.getFields();

    console.log(`Nombre de champs trouvés : ${fields.length}`);
    
    const analysis = fields.map(field => {
      const type = field.constructor.name;
      const name = field.getName();
      return { name, type };
    });

    fs.writeFileSync('pdf_fields_analysis.json', JSON.stringify(analysis, null, 2));
    console.log('Analyse terminée. Résultats sauvegardés dans pdf_fields_analysis.json');
    
    // Afficher les 20 premiers pour un aperçu
    console.log('--- Aperçu des 20 premiers champs ---');
    console.log(analysis.slice(0, 20));

  } catch (err) {
    console.error('Erreur lors de l\'analyse :', err);
  }
}

analyzePdf();
