const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { PDFDocument } = require('pdf-lib');

const app = express();
const PORT = 3000;

app.use(bodyParser.json());
app.use(express.static('public'));

const DATA_FILE = './data/contracts.json';
const MAPPING_FILE = './mapping_complet_v2.json';
const CERFA_TEMPLATE = './cerfa_ apprentissage_10103-14.pdf';

// Charger les données
function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return { contracts: {} };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// =====================
// CRÉATION D'UN NOUVEAU CONTRAT
// =====================
app.post('/api/contracts', (req, res) => {
  const data = loadData();
  const contractId = uuidv4();
  const etudiantToken = uuidv4();
  const entrepriseToken = uuidv4();
  
  data.contracts[contractId] = {
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
  
  saveData(data);
  
  res.json({
    success: true,
    contractId,
    liens: {
      etudiant: `http://localhost:${PORT}/etudiant.html?token=${etudiantToken}`,
      entreprise: `http://localhost:${PORT}/entreprise.html?token=${entrepriseToken}`
    }
  });
});

// =====================
// RÉCUPÉRER TOUS LES CONTRATS (Dashboard)
// =====================
app.get('/api/contracts', (req, res) => {
  const data = loadData();
  const contracts = Object.values(data.contracts).map(c => ({
    id: c.id,
    createdAt: c.createdAt,
    status: c.status,
    etudiantComplete: !!c.etudiant,
    entrepriseComplete: !!c.entreprise,
    liens: {
      etudiant: `http://localhost:${PORT}/etudiant.html?token=${c.tokens.etudiant}`,
      entreprise: `http://localhost:${PORT}/entreprise.html?token=${c.tokens.entreprise}`
    }
  }));
  res.json(contracts);
});

// =====================
// RÉCUPÉRER UN CONTRAT PAR TOKEN
// =====================
app.get('/api/contract/by-token/:token', (req, res) => {
  const { token } = req.params;
  const data = loadData();
  
  for (const contract of Object.values(data.contracts)) {
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
  const data = loadData();
  
  for (const contractId of Object.keys(data.contracts)) {
    if (data.contracts[contractId].tokens.etudiant === token) {
      data.contracts[contractId].etudiant = req.body;
      updateContractStatus(data.contracts[contractId]);
      saveData(data);
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
  const data = loadData();
  
  for (const contractId of Object.keys(data.contracts)) {
    if (data.contracts[contractId].tokens.entreprise === token) {
      data.contracts[contractId].entreprise = req.body;
      updateContractStatus(data.contracts[contractId]);
      saveData(data);
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
  const data = loadData();
  const contract = data.contracts[id];
  
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
    res.setHeader('Content-Disposition', `attachment; filename="cerfa_contrat_${id.slice(0,8)}.pdf"`);
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
  const data = loadData();
  
  if (data.contracts[id]) {
    delete data.contracts[id];
    saveData(data);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Contrat non trouvé' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Serveur CERFA SaaS démarré sur http://localhost:${PORT}`);
  console.log(`📋 Dashboard: http://localhost:${PORT}/`);
});
