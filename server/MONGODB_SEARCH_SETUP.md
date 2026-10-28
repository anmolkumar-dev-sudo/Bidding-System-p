# MongoDB Search autocomplete setup

The auction search endpoints use MongoDB Search (`$search`), not a regular MongoDB text index. A normal Windows `mongod` service does not provide the separate Search process. The simplest setup for this project is a MongoDB Atlas cluster. MongoDB also offers an Atlas Local Docker image for local evaluation.

## Configure the Search index

1. Connect the app to an Atlas cluster by setting `MONGO_URI` in `server/.env` to its application connection string. Keep the username/password private and URL-encode special characters in the password.
2. In Atlas, open the cluster's **Search** tab and create a Search index for database `bidding_app`, collection `products`.
3. Name it `listing_autocomplete`.
4. Choose **JSON Editor** and paste the contents of [`mongodb-search-index.json`](./mongodb-search-index.json).
5. Wait until the index status is **READY**. Existing documents are indexed as the index builds; new and updated listings are kept in sync.
6. In `server/.env`, set `MONGODB_SEARCH_INDEX=listing_autocomplete`, save, and restart `npm start`.

The index maps listing `title` and `description` as autocomplete fields. Edge-gram tokenization supports partial words such as `ca` matching `car`; the API requests fuzzy matches to tolerate small typos. Search suggestions return up to seven matching listings. Pressing Enter runs a paginated search, and the sort menu can order the results by relevance, ending time, listing date, price, or bid count.

## Local-only MongoDB

If `MONGO_URI` still points to the existing Windows MongoDB service, ordinary listing pages continue to work, but Search autocomplete and typed search requests return a configuration error because that server does not host MongoDB Search. To test Search while staying local, use MongoDB's Atlas Local Docker deployment, or use an Atlas cluster. The official self-managed `mongot` route has additional server-version, Linux/Docker, and replica-set requirements.

Search index documentation: <https://www.mongodb.com/docs/atlas/atlas-search/>
