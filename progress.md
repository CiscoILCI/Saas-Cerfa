# ContratFlow - Saas-Cerfa

## État du projet

### ✅ Terminé
- Mapping CERFA v2.2 complet et vérifié (date naissance: 21_7/21_8/21_9)
- Formulaire étudiant (etudiant.html) - tous les champs + UI moderne
- Formulaire entreprise (entreprise.html) - tous les champs + auto-lookup SIRET
- API Vercel serverless (api/index.js) - handler natif sans Express
- Persistance Redis via **Upstash REST API** (clé: UPSTASH_REDIS_REST_URL + TOKEN)
- **Authentification JWT** : login/register pour CFA et Entreprise
- **Dashboard CFA** (dashboard-cfa.html) : gestion contrats, maîtres apprentissage, profil, stats, search/filter, export CSV
- **Dashboard Entreprise** (dashboard-entreprise.html) : profil, contrats, historique, statuts
- **Édition contrat** (edit-contrat.html) : formulaire complet, historique modifications, statuts (pending→partial→ready→validated→completed)
- **Annuaire partagé d'entreprises** : auto-alimenté, recherche par SIRET/nom, autocomplete CFA, auto-lookup entreprise
- Déploiement GitHub + Vercel auto-deploy
- Collapsible remuneration years (années 2, 3, 4 repliées par défaut)

### 📋 À faire (futur)
- Notifications email
- Tests end-to-end
- README avec instructions d'installation

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

### Redis (Upstash REST API)
- **Connexion**: REST API (pas TCP)
- **Variables d'env**: `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`
- **Clés Redis utilisées**:
  - `contracts` (Hash) : contractId → JSON du contrat
  - `tokens` (Hash) : token → { contractId, type }
  - `users` (Hash) : email → JSON { id, email, password, role, profile, createdAt }
  - `maitres:{cfaId}` (Hash) : maId → JSON du maître apprentissage
  - `entreprises_directory` (Hash) : SIRET → JSON { denomination, code_ape, adresse, ... }

### Vercel
- **URL**: https://saas-cerfa.vercel.app
- **GitHub**: https://github.com/CiscoILCI/Saas-Cerfa
- **Framework**: Aucun (static + serverless function)
- **vercel.json**: routes /api/* → api/index.js, reste → public/
- **includeFiles**: mapping_complet_v2.json, cerfa_ apprentissage_10103-14.pdf

### API Endpoints

#### Auth
| Méthode | Route | Description |
|---------|-------|-------------|
| POST | /api/auth/register | Créer compte (CFA ou Entreprise) |
| POST | /api/auth/login | Connexion |
| GET | /api/auth/me | Infos utilisateur connecté |
| PUT | /api/auth/profile | Mettre à jour profil |

#### Contrats (auth CFA)
| Méthode | Route | Description |
|---------|-------|-------------|
| GET | /api/contracts | Liste contrats du CFA |
| POST | /api/contracts | Créer contrat (pré-remplit depuis profil CFA) |
| GET | /api/contracts/:id | Détail contrat |
| PUT | /api/contracts/:id | Modifier contrat |
| PUT | /api/contracts/:id/status | Changer statut |
| GET | /api/contracts/:id/history | Historique modifications |
| GET | /api/contracts/:id/generate-pdf | Générer PDF CERFA |
| DELETE | /api/contracts/:id | Supprimer contrat |

#### Formulaires (token)
| Méthode | Route | Description |
|---------|-------|-------------|
| GET | /api/contract/by-token/:token | Récupérer contrat par token |
| POST | /api/etudiant/:token | Soumettre données étudiant |
| POST | /api/entreprise/:token | Soumettre données entreprise (auto-alimente directory) |

#### Entreprise (auth Entreprise)
| Méthode | Route | Description |
|---------|-------|-------------|
| GET | /api/entreprise/contracts | Contrats de l'entreprise connectée |

#### Annuaire partagé
| Méthode | Route | Description |
|---------|-------|-------------|
| GET | /api/entreprises-directory/search?q=... | Recherche par nom/SIRET/commune (auth CFA) |
| GET | /api/entreprises-directory/:siret | Lookup exact (auth CFA) |
| GET | /api/entreprises-directory/by-siret/:siret | Lookup exact public (formulaire entreprise) |

#### Maîtres d'apprentissage (auth CFA)
| Méthode | Route | Description |
|---------|-------|-------------|
| GET | /api/maitres | Liste maîtres du CFA |
| POST | /api/maitres | Créer maître |
| PUT | /api/maitres/:id | Modifier maître |
| DELETE | /api/maitres/:id | Supprimer maître |

#### Entreprises inscrites (auth CFA)
| Méthode | Route | Description |
|---------|-------|-------------|
| GET | /api/entreprises | Liste entreprises inscrites |

#### Debug
| Méthode | Route | Description |
|---------|-------|-------------|
| GET | /api/debug | État Redis, fichiers, env |
| GET | /api/debug-pdf-fields | Liste champs PDF CERFA |

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
