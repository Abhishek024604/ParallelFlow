---
name: c4-modelling
description: How to model a software system in the C4 style - context, containers, components, deployment - and how to choose component boundaries. Use while writing arch/model.yaml or reviewing one.
---

# C4 modelling for model.yaml

- **Context** (level 1): the system as one box, the people who use it (actors) and the systems it talks to (externals). No technology.
- **Containers** (level 2): the separately running or deployable parts: web or mobile apps, APIs, workers, functions, databases, caches, queues, object storage. In model.yaml these are the `components`.
- **Components** (level 3): the modules inside one container. These belong in that container's LLD (`/swa lld CMP-…`), not in model.yaml.
- **Deployment**: where containers run: clusters, VMs, serverless, managed services, regions.

Choosing boundaries:

1. Start from the architecture style (ADR-0001). A modular monolith has few containers; microservices have one per business capability.
2. Split where a quality scenario needs it: different scaling, availability or security needs, a different data owner, or a separate team.
3. Do not split where it only adds a network hop. Every container must satisfy at least one requirement.
4. Each piece of data has exactly one owning container; others reach it through that owner's API or events.
5. Name containers for what they do (`order-service`, `catalog-db`), in kebab-case.
6. Label every relation with intent and protocol ("places orders (REST/HTTPS)", "OrderPlaced (Kafka)"), and mark event-driven ones `async`.
7. A diagram should fit on one screen: about 15 containers at most. Group, or move detail down to the LLD, when there are more.
