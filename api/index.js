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

// Chemins des fichiers - on essaie plusieurs emplacements possibles
function findFile(filename) {
  const candidates = [
    path.join(__dirname, '..', filename),
    path.join(__dirname, filename),
    path.join(process.cwd(), filename),
    path.resolve(filename)
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0]; // fallback
}

const MAPPING_FILE = findFile('mapping_complet_v2.json');
const CERFA_TEMPLATE = findFile('cerfa_ apprentissage_10103-14.pdf');

console.log('[INIT] __dirname:', __dirname);
console.log('[INIT] cwd:', process.cwd());
console.log('[INIT] MAPPING_FILE:', MAPPING_FILE, '| exists:', fs.existsSync(MAPPING_FILE));
console.log('[INIT] CERFA_TEMPLATE:', CERFA_TEMPLATE, '| exists:', fs.existsSync(CERFA_TEMPLATE));

// Helper: obtenir l'URL de base dynamiquement
function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

// =====================
// ENDPOINT DEBUG (à supprimer en prod)
// =====================
app.get('/api/debug', (req, res) => {
  const dirnameFiles = fs.existsSync(__dirname) ? fs.readdirSync(__dirname) : [];
  const parentFiles = fs.existsSync(path.join(__dirname, '..')) ? fs.readdirSync(path.join(__dirname, '..')) : [];
  let cwdFiles = [];
  try { cwdFiles = fs.readdirSync(process.cwd()); } catch(e) { cwdFiles = ['ERROR: ' + e.message]; }

  res.json({
    env: {
      __dirname,
      cwd: process.cwd(),
      NODE_ENV: process.env.NODE_ENV,
      VERCEL: process.env.VERCEL,
      VERCEL_ENV: process.env.VERCEL_ENV
    },
    files: {
      inDirname: dirnameFiles,
      inParent: parentFiles,
      inCwd: cwdFiles
    },
    paths: {
      MAPPING_FILE,
      MAPPING_EXISTS: fs.existsSync(MAPPING_FILE),
      CERFA_TEMPLATE,
      CERFA_EXISTS: fs.existsSync(CERFA_TEMPLATE)
    },
    store: {
      contractCount: Object.keys(store.contracts).length
    }
  });
});

// =====================
// CRÉATION D'UN NOUVEAU CONTRAT
// =====================
app.post('/api/contracts', (req, res) => {
  try {
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
  } catch (error) {
    console.error('[ERROR] POST /api/contracts:', error);
    res.status(500).json({ error: error.message, stack: error.stack });
  }
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

// Error handler global
app.use((err, req, res, next) => {
  console.error('[GLOBAL ERROR]', err);
  res.status(500).json({ error: err.message, stack: err.stack });
});

// Export pour Vercel
module.exports = app;
