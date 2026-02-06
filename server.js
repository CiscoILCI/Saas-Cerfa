const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const { fillCerfa } = require('./fill_cerfa');

const app = express();
const PORT = 3000;

app.use(bodyParser.json());
app.use(express.static('public'));

const MAPPING = JSON.parse(fs.readFileSync('mapping_complet.json', 'utf8'));

app.post('/api/generate-cerfa', async (req, res) => {
  try {
    const data = req.body;
    console.log('Données reçues du formulaire :', data);

    const inputPdf = 'cerfa_ apprentissage_10103-14.pdf';
    const outputPdf = `cerfa_generated_${Date.now()}.pdf`;
    
    await fillCerfa(data, MAPPING, inputPdf, outputPdf);

    // Renvoie le fichier au client
    res.download(outputPdf, 'cerfa_rempli.pdf', (err) => {
      if (err) console.error('Erreur download:', err);
      
      // Nettoyage du fichier temporaire après envoi
      fs.unlinkSync(outputPdf);
    });

  } catch (error) {
    console.error('Erreur serveur:', error);
    res.status(500).json({ error: 'Erreur lors de la génération du PDF' });
  }
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});
