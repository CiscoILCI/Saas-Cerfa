# ContratFlow - Saas-Cerfa

## État du projet

### ✅ Terminé
- Mapping CERFA v2.2 complet et vérifié (date naissance: 21_7/21_8/21_9)
- Formulaire étudiant (etudiant.html) - tous les champs + UI ContratFlow
- Formulaire entreprise (entreprise.html) - tous les champs + UI ContratFlow
- Dashboard (index.html) - design moderne + modale suppression custom
- Serveur local (server_v2.js) - stockage fichier JSON
- API Vercel serverless (api/index.js) - handler natif sans Express
- Persistance Redis via Upstash (remplace le stockage mémoire)
- Déploiement GitHub + Vercel auto-deploy

### 🔧 En cours
- Test complet du flux sur Vercel avec Redis persistant

### 📋 À faire (futur)
- Authentification / droits d'accès
- README avec instructions d'installation
- Tests end-to-end

---

## Architecture

```
📁 Saas-Cerfa/
├── api/index.js              ← API Vercel serverless (handler natif, pas Express)
├── public/
│   ├── index.html            ← Dashboard
│   ├── etudiant.html         ← Formulaire apprenti
│   └── entreprise.html       ← Formulaire entreprise
├── cerfa_ apprentissage_10103-14.pdf  ← Template CERFA PDF
├── mapping_complet_v2.json   ← Mapping champs formulaire → champs PDF
├── server_v2.js              ← Serveur dev local (Express + fichier JSON)
├── vercel.json               ← Config Vercel (routes + includeFiles)
├── package.json
└── .gitignore
```

---

## Infos techniques

### Redis (Upstash via Vercel Marketplace)
- **Database**: saas-cerfa-db
- **Redis ID**: ca3de94b-dbc1-45f4-b911-54ee0afecda6
- **Plan**: Redis/30 MB (gratuit)
- **Région**: EU West 3 (Paris)
- **Variable d'env**: `REDIS_URL` (connexion TCP)
- **Client**: `node-redis` (createClient)
- **Clés utilisées**:
  - `contracts` (Hash) : contractId → JSON du contrat
  - `tokens` (Hash) : token → { contractId, type }

### Vercel
- **URL**: https://saas-cerfa.vercel.app
- **GitHub**: https://github.com/CiscoILCI/Saas-Cerfa
- **Framework**: Aucun (static + serverless function)
- **vercel.json**: routes /api/* → api/index.js, reste → public/
- **includeFiles**: mapping_complet_v2.json, cerfa_ apprentissage_10103-14.pdf

### API Endpoints
| Méthode | Route | Description |
|---------|-------|-------------|
| GET | /api/debug | Debug: état Redis, fichiers, env |
| GET | /api/contracts | Liste tous les contrats |
| POST | /api/contracts | Créer un nouveau contrat |
| GET | /api/contract/by-token/:token | Récupérer contrat par token |
| POST | /api/etudiant/:token | Soumettre données étudiant |
| POST | /api/entreprise/:token | Soumettre données entreprise |
| GET | /api/contracts/:id/generate-pdf | Générer et télécharger le PDF |
| DELETE | /api/contracts/:id | Supprimer un contrat |

### Mapping CERFA
- Version: 2.2
- Fichier: mapping_complet_v2.json
- Référence debug: cerfa_mapping_numeros.pdf (local uniquement, gitignored)
- Date naissance apprenti: 21_7 (jour) / 21_8 (mois) / 21_9 (année)

### Corrections appliquées
- maitre_apprentissage_1 → maitre_apprentissage (formulaire entreprise)
- representant_legal.nom + .prenom → .nom_prenom (champ unique 8_35 sur CERFA)
- Champs manquants ajoutés: contrat, rémunération, maître apprentissage, CFA
- Attestation "Fait le" supprimé (inexistant sur CERFA)

---

## Dev local
```bash
npm install
node server_v2.js
# → http://localhost:3000
```

## Déploiement
Push sur `main` → Vercel auto-deploy
