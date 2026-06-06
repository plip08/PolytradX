# Plan d'industrialisation

## Objectif

Passer de l’architecture prototype solide à un déploiement fiable et maintenable pour un bot de trading Polymarket.

## 5 actions prioritaires

### 1. Tests et validation système
- écrire des tests unitaires pour :
  - chaque stratégie (`src/strategies/*`)
  - `StrategyEngine`, `ExecutionManager`, `RiskController`, `RiskDecisionEngine`
- ajouter des tests d’intégration sur un nœud Polygon local / sandbox
- simuler :
  - données de marché stale / manquantes
  - ordres rejetés / transactions revert
  - circuit breaker déclenché

### 2. Robustesse du flux de données de marché
- valider la récupération des données Polymarket
- implémenter la reprise automatique en cas de déconnexion websocket
- ajouter un mode de cache / fallback sur Redis
- mesurer et instrumenter la latence de `MarketScanner`

### 3. Séparation complète des plans de décision et exécution
- renforcer la couche `MarketDataCache` comme source de vérité
- faire exécuter les décisions uniquement via `ExecutionManager`
- supprimer les appels directs à `ExecutionEngine` depuis les stratégies
- documenter l’interface `StrategyDecision` et les invariants attendus

### 4. Durcissement de l’exécution et du risque
- vérifier et améliorer :
  - la gestion des nonces et des transactions en double
  - la création de transactions EIP-1559 optimisées
  - la persistance fiable des trades dans PostgreSQL
- refaire le `RiskController` avec :
  - limites d’exposition par marché
  - limites par stratégie
  - stop-loss / take-profit automatisés
- ajouter des seuils de protection en amont sur les décisions stratégiques

### 5. Surveillance opérationnelle et mise en production
- exporter des métriques générales :
  - nombre de décisions
  - taux d’exécution
  - latence de réception de données
  - état du circuit breaker
- ajouter des health checks API et Redis/Postgres
- définir un déploiement conteneurisé léger
- fournir un `Dockerfile`, un `docker-compose.yml` et une pipeline CI simple
- utiliser un nœud Polygon dédié plutôt qu’un RPC public

## Ce qu'il faut ajouter ou durcir (revue d'XP)
- **Stale Data Handling**
  - chaque tick doit porter un `receivedAt` milliseconde
  - les stratégies de latence et de logique doivent s’inhiber si la donnée dépasse `MARKET_DATA_STALE_THRESHOLD_MS`
  - cela doit être force dans `MarketDataCache` et dans `StrategyEngine`
- **Redis n’est pas le chemin critique du flux marché**
  - Redis est bon pour l’état global et le partage non critique
  - pour la latence pure, conserver les données de marché en mémoire et éviter les sérialisations/disparitions fréquentes
- **Nonce Manager local**
  - l’`ExecutionManager` doit gérer le nonce localement
  - incrémenter le nonce dès qu’une transaction est signée, sans attendre le mining
  - prévoir un remplacement (speed up / cancel) avec le même nonce en cas de blocage
- **UMA / dispute sniping**
  - surveiller l’exposition sur les marchés potentiellement contestés
  - ajouter des métriques spécifiques au risque de résolution et aux propositions d’oracle UMA
  - ne pas laisser trop de capital bloqué sur un marché contesté

## Livrables immédiats
- `PRODUCTION_PLAN.md` (ce document)
- tests unitaires et d’intégration
- README d’exploitation / déploiement
- `docker-compose` ou scripts de déploiement
- surveillance et alertes

## Notes importantes
- le code actuel est une base solide, mais pas encore un système HFT de production.
- la prochaine étape consiste à faire tourner le bot sur un environnement de test contrôlé avec données réelles.
- dès que les tests sont en place, il faut prioriser la stabilité du flux de données avant toute optimisation de stratégie.
