const { PDFDocument } = require('pdf-lib');
const fs = require('fs');

async function createDebugPdf() {
  try {
    const pdfBytes = fs.readFileSync('cerfa_ apprentissage_10103-14.pdf');
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const form = pdfDoc.getForm();
    const fields = form.getFields();

    console.log(`Remplissage de ${fields.length} champs avec leurs identifiants...`);

    fields.forEach(field => {
      const name = field.getName();
      const type = field.constructor.name;

      try {
        if (type === 'PDFTextField') {
          // Extraire seulement le numéro pour plus de lisibilité
          // "Zone de texte 8_2" -> "8_2"
          // "Zone de texte 21_15" -> "21_15"
          let shortName = name;
          if (name.includes('Zone de texte')) {
            shortName = name.replace('Zone de texte ', '');
          } else if (name.includes('Case')) {
            shortName = name.replace('Case #C3#A0 cocher ', 'C');
          }
          field.setText(shortName); 
        } else if (type === 'PDFCheckBox') {
          // On coche la case pour savoir où elle est
          field.check();
        }
      } catch (e) {
        console.warn(`Impossible de modifier le champ ${name}: ${e.message}`);
      }
    });

    const pdfOut = await pdfDoc.save();
    fs.writeFileSync('cerfa_mapping_numeros.pdf', pdfOut);
    console.log('Succès ! Ouvrez "cerfa_mapping_debug.pdf" pour voir à quoi correspondent les champs.');

  } catch (err) {
    console.error('Erreur :', err);
  }
}

createDebugPdf();
