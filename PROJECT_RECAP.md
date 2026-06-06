# Polymarket Trading Bot - Project Recap

## Objectif général

Cette application est une architecture de trading automatisé pour Polymarket, conçue en TypeScript avec une séparation claire entre le moteur de bot et l'API.

L'architecture repose sur :
- Redis Streams pour la file de commandes et la gestion de flux
- Redis Pub/Sub pour les snapshots et la télémétrie
- Fastify pour l'API backend
- Prisma/PostgreSQL pour la persistante métier
- ethers v6 pour l'exécution des transactions et la connexion blockchain
- Un modèle producteur/consommateur de commandes avec supervision du risque et du circuit breaker

## Principaux composants implémentés

### 1. Bus Redis et transport
- `src/services/redisBus.ts`
  - Enqueue / dequeue des commandes bot
  - Lire et ack des commandes Redis Stream
  - Publication et abonnement aux snapshots
  - Verrous Redis pour exécution atomique

### 2. API backend sécurisé
- `src/api/server.ts`
  - Fastify avec hook d'authentification
  - Endpoints d'envoi de commande, configuration de stratégie, status circuit breaker
  - Endpoint de snapshot bot en temps réel
  - Requêtes métier : historique de trades, événements de risque, configurations

### 3. Persistance métier
- `src/services/persistence.ts`
  - CRUD utilisateur
  - Historique des trades
  - Enregistrement d'événements de risque et d'audit
  - Configuration des stratégies
  - Mise à jour du statut des trades

### 4. Moteur d'exécution
- `src/services/executionEngine.ts`
  - Exécution réelle et simulation
  - Gestion du mode dry-run
  - Création de trade simulé et persistance de l'exécution
  - Attente de receipt et mise à jour du statut final

### 5. Circuit breaker et gestion du risque
- `src/services/circuitBreaker.ts`
  - Suivi du capital, drawdown, pertes consécutives
  - Décision d'autoriser / refuser l'exécution
  - État actuel exposé dans les snapshots

- `src/services/marketRiskMonitor.ts`
  - Supervision de la liquidité, spread, volatilité, profondeur d'orderbook
  - Détection de marché stale
  - Publication de commandes de risque (`EMERGENCY_STOP`, `PAUSE_STRATEGY`)
  - Persistance d'événements de risque en base

### 6. Command consumer et snapshot bot
- `src/services/botCommandConsumer.ts`
  - Consommation continue des commandes Redis Stream
  - Application des commandes: activer/désactiver stratégie, stop, configuration
  - Publication périodique de snapshot bot
  - Enrichissement du snapshot avec état circuit breaker, stratégies, positions, logs et alertes

### 7. État central du bot
- `src/services/botState.ts`
  - État des stratégies et snapshots
  - Enregistrement des alertes et logs internes
  - Suivi des positions ouvertes
  - Exposition des données de télémétrie pour publication

### 8. Dispatcher de stratégie
- `src/services/strategyDispatcher.ts`
  - Cycle d'évaluation des stratégies activées
  - Exécution des décisions de trading
  - Mise à jour de `BotState` avec exécution et position

### 9. Intégration Polymarket
- `src/integrations/polymarketClient.ts`
  - Client de récupération de données de marché (orderbook)
  - Envoi des ordres vers Polymarket ou simulation si nécessaire

## Structure de types clés
- `src/types/redis.ts` : commandes et snapshots Redis
- `src/types/strategy.ts` : définition des stratégies et résultats
- `src/types/market.ts` : état de marché, livres d'ordres, données feed

## Flux de fonctionnement

1. L'API publie une commande bot dans Redis.
2. `BotCommandConsumer` lit la commande et l'applique.
3. Les stratégies évaluent le marché dans `StrategyDispatcher`.
4. `ExecutionEngine` exécute la transaction ou simule le trade.
5. `CircuitBreaker` vérifie si l'exécution est autorisée.
6. `MarketRiskMonitor` surveille le marché et génère des commandes de protection.
7. `BotState` centralise l'état des stratégies, positions, logs et alertes.
8. Les snapshots sont publiés via Redis Pub/Sub pour l'observabilité.

## État actuel du projet

- Architecture modulaire mise en place
- Commandes Redis fonctionnelles
- API backend et sécurité authentifiée implémentées
- Persistence Prisma configurée et utilisée
- Exécution simulée / réelle supportée
- Circuit breaker et monitoring de risque ajoutés
- Snapshot bot exposé avec télémétrie
- Suivi de positions et journaux internes ajoutés

## Points déjà stabilisés

- Compilateur TypeScript passe (`npx tsc --noEmit`)
- Types alignés entre snapshot et état bot
- Simulation plus circuit breaker intégrés
- API capable de retourner l'état de santé du bot

## Prochaines améliorations possibles

- Remplir de façon plus précise `BotState.positions` avec des positions réelles depuis les trades
- Ajouter des métriques PnL réalisées / non réalisées dans le snapshot
- Ajouter un scheduler autonome de commandes périodiques
- Améliorer la logique de stratégie et la gestion de risque fine
- Ajouter un `README.md` détaillé et un schéma d'architecture

## Fichiers principaux à consulter

- `src/api/server.ts`
- `src/services/redisBus.ts`
- `src/services/botCommandConsumer.ts`
- `src/services/botState.ts`
- `src/services/strategyDispatcher.ts`
- `src/services/executionEngine.ts`
- `src/services/marketRiskMonitor.ts`
- `src/services/circuitBreaker.ts`
- `src/services/persistence.ts`
- `src/integrations/polymarketClient.ts`

---

Ce document synthétise l’état actuel du projet et ce qui a déjà été mis en place.