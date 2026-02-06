const { PDFDocument } = require('pdf-lib');
const fs = require('fs');

/**
 * Remplit le CERFA avec les données fournies via un fichier de mapping.
 * @param {Object} data - Les données métier (ex: { apprenti: { nom: "Dupont" } })
 * @param {Object} mapping - La correspondance (ex: { "apprenti.nom": "Zone de texte 21" })
 * @param {String} inputPdfPath - Chemin du PDF vierge
 * @param {String} outputPdfPath - Chemin du PDF rempli
 */
async function fillCerfa(data, mapping, inputPdfPath, outputPdfPath) {
  try {
    const pdfBytes = fs.readFileSync(inputPdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const form = pdfDoc.getForm();

    console.log(`Remplissage du formulaire...`);
    let fieldsFilled = 0;

    // Fonction utilitaire pour accéder aux propriétés imbriquées (ex: "apprenti.nom")
    const getNestedValue = (obj, path) => {
      return path.split('.').reduce((prev, curr) => prev ? prev[curr] : undefined, obj);
    };

    for (const [dataKey, pdfFieldId] of Object.entries(mapping)) {
      const value = getNestedValue(data, dataKey);
      
      if (value === undefined || value === null) {
        console.warn(`⚠️ Donnée manquante pour la clé : ${dataKey}`);
        continue;
      }

      try {
        const field = form.getField(pdfFieldId);
        const type = field.constructor.name;

        if (type === 'PDFTextField') {
          field.setText(String(value));
          fieldsFilled++;
        } else if (type === 'PDFCheckBox') {
          if (value === true || value === 'true' || value === 'OUI') {
            field.check();
            fieldsFilled++;
          } else {
            field.uncheck();
          }
        }
      } catch (err) {
        console.warn(`❌ Erreur sur le champ PDF "${pdfFieldId}" (Clé: ${dataKey}) : ${err.message}`);
      }
    }

    const pdfBytesSaved = await pdfDoc.save();
    fs.writeFileSync(outputPdfPath, pdfBytesSaved);
    console.log(`✅ Terminé ! ${fieldsFilled} champs remplis.`);
    console.log(`Fichier généré : ${outputPdfPath}`);

  } catch (err) {
    console.error('Erreur critique lors du remplissage :', err);
  }
}

// Exécution si appelé directement
if (require.main === module) {
  // Chargement des fichiers de config
  try {
    const data = JSON.parse(fs.readFileSync('poc_data.json', 'utf8'));
    const mapping = JSON.parse(fs.readFileSync('poc_mapping.json', 'utf8'));
    
    fillCerfa(
      data, 
      mapping, 
      'cerfa_ apprentissage_10103-14.pdf', 
      'cerfa_rempli_test.pdf'
    );
  } catch (e) {
    console.log("Usage: node fill_cerfa.js (Assurez-vous que poc_data.json et poc_mapping.json existent)");
    console.error(e.message);
  }
}

module.exports = { fillCerfa };
