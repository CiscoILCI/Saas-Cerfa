const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { PDFDocument } = require('pdf-lib');

const app = express();
app.use(express.json());

// =====================
// STOCKAGE EN MÉMOIRE (POC)
// En production, utiliser une base de données (Vercel KV, Supabase, etc.)
// =====================
const store = { contracts: {} };

const MAPPING_FILE = path.join(__dirname, '..', 'mapping_complet_v2.json');
const CERFA_TEMPLATE = path.join(__dirname, '..', 'cerfa_ apprentissage_10103-14.pdf');

// Helper: obtenir l'URL de base dynamiquement
function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

// =====================
// CRÉATION D'UN NOUVEAU CONTRAT
// =====================
app.post('/api/contracts', (req, res) => {
  const contractId = uuidv4();
  const etudiantToken = uuidv4();
  const entrepriseToken = uuidv4();
  const baseUrl = getBaseUrl(req);

  store.contracts[contractId] = {
    id: contractId,
    createdAt: new Date().toISOString(),
    status: 'pending',
    tokens: {
      etudiant: etudiantToken,
      entreprise: entrepriseToken
    },
    etudiant: null,
    entreprise: null,
    formation: null
  };

  res.json({
    success: true,
    contractId,
    liens: {
      etudiant: `${baseUrl}/etudiant.html?token=${etudiantToken}`,
      entreprise: `${baseUrl}/entreprise.html?token=${entrepriseToken}`
    }
  });
});

// =====================
// RÉCUPÉRER TOUS LES CONTRATS (Dashboard)
// =====================
app.get('/api/contracts', (req, res) => {
  const baseUrl = getBaseUrl(req);
  const contracts = Object.values(store.contracts).map(c => ({
    id: c.id,
    createdAt: c.createdAt,
    status: c.status,
    etudiantComplete: !!c.etudiant,
    entrepriseComplete: !!c.entreprise,
    liens: {
      etudiant: `${baseUrl}/etudiant.html?token=${c.tokens.etudiant}`,
      entreprise: `${baseUrl}/entreprise.html?token=${c.tokens.entreprise}`
    }
  }));
  res.json(contracts);
});

// =====================
// RÉCUPÉRER UN CONTRAT PAR TOKEN
// =====================
app.get('/api/contract/by-token/:token', (req, res) => {
  const { token } = req.params;

  for (const contract of Object.values(store.contracts)) {
    if (contract.tokens.etudiant === token) {
      return res.json({
        type: 'etudiant',
        contractId: contract.id,
        data: contract.etudiant,
        complete: !!contract.etudiant
      });
    }
    if (contract.tokens.entreprise === token) {
      return res.json({
        type: 'entreprise',
        contractId: contract.id,
        data: contract.entreprise,
        complete: !!contract.entreprise
      });
    }
  }

  res.status(404).json({ error: 'Token invalide' });
});

// =====================
// SOUMETTRE DONNÉES ÉTUDIANT
// =====================
app.post('/api/etudiant/:token', (req, res) => {
  const { token } = req.params;

  for (const contractId of Object.keys(store.contracts)) {
    if (store.contracts[contractId].tokens.etudiant === token) {
      store.contracts[contractId].etudiant = req.body;
      updateContractStatus(store.contracts[contractId]);
      return res.json({ success: true, message: 'Données étudiant enregistrées' });
    }
  }

  res.status(404).json({ error: 'Token invalide' });
});

// =====================
// SOUMETTRE DONNÉES ENTREPRISE
// =====================
app.post('/api/entreprise/:token', (req, res) => {
  const { token } = req.params;

  for (const contractId of Object.keys(store.contracts)) {
    if (store.contracts[contractId].tokens.entreprise === token) {
      store.contracts[contractId].entreprise = req.body;
      updateContractStatus(store.contracts[contractId]);
      return res.json({ success: true, message: 'Données entreprise enregistrées' });
    }
  }

  res.status(404).json({ error: 'Token invalide' });
});

// =====================
// METTRE À JOUR LE STATUT DU CONTRAT
// =====================
function updateContractStatus(contract) {
  if (contract.etudiant && contract.entreprise) {
    contract.status = 'ready';
  } else if (contract.etudiant || contract.entreprise) {
    contract.status = 'partial';
  } else {
    contract.status = 'pending';
  }
}

// =====================
// GÉNÉRER LE PDF
// =====================
app.get('/api/contracts/:id/generate-pdf', async (req, res) => {
  const { id } = req.params;
  const contract = store.contracts[id];

  if (!contract) {
    return res.status(404).json({ error: 'Contrat non trouvé' });
  }

  if (contract.status !== 'ready') {
    return res.status(400).json({
      error: 'Le contrat n\'est pas complet',
      etudiantComplete: !!contract.etudiant,
      entrepriseComplete: !!contract.entreprise
    });
  }

  try {
    const pdfBytes = fs.readFileSync(CERFA_TEMPLATE);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const form = pdfDoc.getForm();
    const mapping = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8'));

    // Fusionner les données
    const mergedData = {
      ...contract.entreprise,
      ...contract.etudiant
    };

    // Fonction récursive pour aplatir les objets
    function flattenObject(obj, prefix = '') {
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        const newKey = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          Object.assign(result, flattenObject(value, newKey));
        } else {
          result[newKey] = value;
        }
      }
      return result;
    }

    // Fonction récursive pour aplatir le mapping
    function flattenMapping(obj, prefix = '') {
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        if (key.startsWith('_')) continue;
        const newKey = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object') {
          Object.assign(result, flattenMapping(value, newKey));
        } else {
          result[newKey] = value;
        }
      }
      return result;
    }

    const flatData = flattenObject(mergedData);
    const flatMapping = flattenMapping(mapping);

    let filledCount = 0;

    for (const [dataKey, pdfFieldName] of Object.entries(flatMapping)) {
      const value = flatData[dataKey];
      if (value === undefined || value === null || value === '') continue;

      try {
        const field = form.getField(pdfFieldName);
        const type = field.constructor.name;

        if (type === 'PDFTextField') {
          field.setText(String(value));
          filledCount++;
        } else if (type === 'PDFCheckBox') {
          if (value === true || value === 'true' || value === 'OUI' || value === 'on') {
            field.check();
            filledCount++;
          }
        }
      } catch (e) {
        // Champ non trouvé - ignorer
      }
    }

    console.log(`PDF généré: ${filledCount} champs remplis`);

    const pdfOut = await pdfDoc.save();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="cerfa_contrat_${id.slice(0, 8)}.pdf"`);
    res.send(Buffer.from(pdfOut));

  } catch (error) {
    console.error('Erreur génération PDF:', error);
    res.status(500).json({ error: 'Erreur lors de la génération du PDF' });
  }
});

// =====================
// SUPPRIMER UN CONTRAT
// =====================
app.delete('/api/contracts/:id', (req, res) => {
  const { id } = req.params;

  if (store.contracts[id]) {
    delete store.contracts[id];
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Contrat non trouvé' });
  }
});

// Export pour Vercel
module.exports = app;
