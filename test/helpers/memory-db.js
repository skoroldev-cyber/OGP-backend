const clone = (value) => (value === undefined ? undefined : structuredClone(value));

function getPath(document, path) {
  return path.split('.').reduce((node, key) => {
    if (node == null) return undefined;
    if (Array.isArray(node) && !/^\d+$/.test(key)) {
      const collected = node
        .map((item) => (item == null ? undefined : item[key]))
        .filter((value) => value !== undefined);
      return collected.length > 0 ? collected : undefined;
    }
    return node[key];
  }, document);
}

function setPath(document, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let node = document;
  for (const key of keys) {
    if (node[key] === null || typeof node[key] !== 'object') node[key] = {};
    node = node[key];
  }
  node[last] = value;
}

function unsetPath(document, path) {
  const keys = path.split('.');
  const last = keys.pop();
  let node = document;
  for (const key of keys) {
    if (node == null || typeof node !== 'object') return;
    node = node[key];
  }
  if (node && typeof node === 'object') delete node[last];
}

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);

function matchesCondition(actual, condition) {
  if (isPlainObject(condition)) {
    for (const [operator, operand] of Object.entries(condition)) {
      switch (operator) {
        case '$eq':
          if (!valuesEqual(actual, operand)) return false;
          break;
        case '$ne':
          if (valuesEqual(actual, operand)) return false;
          break;
        case '$in':
          if (!operand.some((candidate) => valuesEqual(actual, candidate))) return false;
          break;
        case '$nin':
          if (operand.some((candidate) => valuesEqual(actual, candidate))) return false;
          break;
        case '$exists':
          if ((actual !== undefined) !== Boolean(operand)) return false;
          break;
        case '$gt':
          if (!(compare(actual, operand) > 0)) return false;
          break;
        case '$gte':
          if (!(compare(actual, operand) >= 0)) return false;
          break;
        case '$lt':
          if (!(compare(actual, operand) < 0)) return false;
          break;
        case '$lte':
          if (!(compare(actual, operand) <= 0)) return false;
          break;
        case '$regex': {
          const re = operand instanceof RegExp ? operand : new RegExp(operand);
          if (typeof actual !== 'string' || !re.test(actual)) return false;
          break;
        }
        default:
          throw new Error(`memory-db: unsupported query operator "${operator}"`);
      }
    }
    return true;
  }
  return valuesEqual(actual, condition);
}

function valuesEqual(a, b) {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Date || b instanceof Date) {
    const left = a instanceof Date ? a.getTime() : new Date(a).getTime();
    const right = b instanceof Date ? b.getTime() : new Date(b).getTime();
    return left === right;
  }
  if (Array.isArray(a) && !Array.isArray(b)) return a.some((item) => valuesEqual(item, b));
  if (isPlainObject(a) && isPlainObject(b)) return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

function compare(a, b) {
  const left = a instanceof Date ? a.getTime() : a;
  const right = b instanceof Date ? b.getTime() : b;
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function matchesFilter(document, filter = {}) {
  for (const [key, condition] of Object.entries(filter)) {
    if (key === '$and') {
      if (!condition.every((sub) => matchesFilter(document, sub))) return false;
    } else if (key === '$or') {
      if (!condition.some((sub) => matchesFilter(document, sub))) return false;
    } else if (key === '$nor') {
      if (condition.some((sub) => matchesFilter(document, sub))) return false;
    } else if (!matchesCondition(getPath(document, key), condition)) {
      return false;
    }
  }
  return true;
}

function applyUpdate(document, update) {
  const hasOperators = Object.keys(update).some((key) => key.startsWith('$'));
  if (!hasOperators) {
    const id = document._id;
    for (const key of Object.keys(document)) delete document[key];
    Object.assign(document, clone(update));
    document._id = id;
    return document;
  }

  for (const [operator, fields] of Object.entries(update)) {
    switch (operator) {
      case '$set':
      case '$setOnInsert':
        for (const [path, value] of Object.entries(fields)) setPath(document, path, clone(value));
        break;
      case '$unset':
        for (const path of Object.keys(fields)) unsetPath(document, path);
        break;
      case '$inc':
        for (const [path, amount] of Object.entries(fields)) {
          setPath(document, path, (getPath(document, path) ?? 0) + amount);
        }
        break;
      case '$push':
        for (const [path, value] of Object.entries(fields)) {
          const current = getPath(document, path);
          const list = Array.isArray(current) ? current : [];
          if (isPlainObject(value) && '$each' in value) list.push(...clone(value.$each));
          else list.push(clone(value));
          setPath(document, path, list);
        }
        break;
      case '$addToSet':
        for (const [path, value] of Object.entries(fields)) {
          const current = getPath(document, path);
          const list = Array.isArray(current) ? current : [];
          if (!list.some((item) => valuesEqual(item, value))) list.push(clone(value));
          setPath(document, path, list);
        }
        break;
      case '$pull':
        for (const [path, value] of Object.entries(fields)) {
          const current = getPath(document, path);
          if (Array.isArray(current)) {
            setPath(
              document,
              path,
              current.filter((item) => !matchesCondition(item, value)),
            );
          }
        }
        break;
      case '$max':
        for (const [path, value] of Object.entries(fields)) {
          const current = getPath(document, path);
          if (current === undefined || compare(value, current) > 0) setPath(document, path, clone(value));
        }
        break;
      case '$min':
        for (const [path, value] of Object.entries(fields)) {
          const current = getPath(document, path);
          if (current === undefined || compare(value, current) < 0) setPath(document, path, clone(value));
        }
        break;
      case '$currentDate':
        for (const path of Object.keys(fields)) setPath(document, path, new Date());
        break;
      default:
        throw new Error(`memory-db: unsupported update operator "${operator}"`);
    }
  }
  return document;
}

function project(document, projection) {
  if (!projection || Object.keys(projection).length === 0) return clone(document);
  const including = Object.entries(projection).some(([key, value]) => value && key !== '_id');
  const result = {};
  if (including) {
    if (projection._id !== 0) result._id = document._id;
    for (const [path, include] of Object.entries(projection)) {
      if (!include || path === '_id') continue;
      const value = getPath(document, path);
      if (value !== undefined) setPath(result, path, clone(value));
    }
    return result;
  }
  Object.assign(result, clone(document));
  for (const [path, include] of Object.entries(projection)) {
    if (!include) unsetPath(result, path);
  }
  return result;
}

function sortDocuments(documents, sort) {
  if (!sort) return documents;
  const entries = Object.entries(sort);
  return [...documents].sort((a, b) => {
    for (const [path, direction] of entries) {
      const result = compare(getPath(a, path), getPath(b, path));
      if (result !== 0) return direction < 0 ? -result : result;
    }
    return 0;
  });
}

let idCounter = 0;
const nextId = () => `mem_${(idCounter += 1).toString(36).padStart(8, '0')}`;

class MemoryCollection {
  constructor(name) {
    this.name = name;
    this.documents = new Map();
    this.uniqueIndexes = [];
  }

  declareUnique(keys, name = keys.join('_')) {
    this.uniqueIndexes.push({ keys, name });
    return this;
  }

  #assertUnique(candidate, ignoreId = null) {
    for (const index of this.uniqueIndexes) {
      const values = index.keys.map((key) => getPath(candidate, key));
      if (values.some((value) => value === undefined || value === null)) continue;
      for (const [id, existing] of this.documents) {
        if (id === ignoreId) continue;
        if (index.keys.every((key, i) => valuesEqual(getPath(existing, key), values[i]))) {
          const error = new Error(
            `E11000 duplicate key error collection: ${this.name} index: ${index.name}`,
          );
          error.code = 11000;
          throw error;
        }
      }
    }
  }

  async insertOne(document) {
    const stored = clone(document);
    if (stored._id === undefined) stored._id = nextId();
    if (this.documents.has(stored._id)) {
      const error = new Error(`E11000 duplicate key error collection: ${this.name} index: _id_`);
      error.code = 11000;
      throw error;
    }
    this.#assertUnique(stored);
    this.documents.set(stored._id, stored);
    return { acknowledged: true, insertedId: stored._id };
  }

  async insertMany(documents) {
    const insertedIds = {};
    for (const [i, document] of documents.entries()) {
      const { insertedId } = await this.insertOne(document);
      insertedIds[i] = insertedId;
    }
    return { acknowledged: true, insertedCount: documents.length, insertedIds };
  }

  #matching(filter) {
    return [...this.documents.values()].filter((document) => matchesFilter(document, filter));
  }

  async findOne(filter = {}, options = {}) {
    const [found] = sortDocuments(this.#matching(filter), options.sort);
    return found ? project(found, options.projection) : null;
  }

  find(filter = {}, options = {}) {
    let results = sortDocuments(this.#matching(filter), options.sort);
    const cursor = {
      sort: (sort) => {
        results = sortDocuments(results, sort);
        return cursor;
      },
      skip: (count) => {
        results = results.slice(count);
        return cursor;
      },
      limit: (count) => {
        results = results.slice(0, count);
        return cursor;
      },
      project: (projection) => {
        results = results.map((document) => project(document, projection));
        return cursor;
      },
      toArray: async () => results.map((document) => project(document, options.projection)),
      [Symbol.asyncIterator]: async function* iterate() {
        for (const document of results) yield project(document, options.projection);
      },
    };
    if (options.skip) cursor.skip(options.skip);
    if (options.limit) cursor.limit(options.limit);
    return cursor;
  }

  async countDocuments(filter = {}) {
    return this.#matching(filter).length;
  }

  async updateOne(filter, update, options = {}) {
    const [existing] = this.#matching(filter);

    if (!existing) {
      if (!options.upsert) {
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: null };
      }
      const seed = {};
      for (const [key, condition] of Object.entries(filter)) {
        if (!key.startsWith('$') && !isPlainObject(condition)) setPath(seed, key, clone(condition));
      }
      applyUpdate(seed, update);
      if (seed._id === undefined) seed._id = nextId();
      this.#assertUnique(seed);
      this.documents.set(seed._id, seed);
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: seed._id };
    }

    const candidate = clone(existing);
    applyUpdate(candidate, update);
    this.#assertUnique(candidate, existing._id);
    this.documents.set(existing._id, candidate);
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedId: null };
  }

  async updateMany(filter, update) {
    const matched = this.#matching(filter);
    for (const existing of matched) {
      const candidate = clone(existing);
      applyUpdate(candidate, update);
      this.documents.set(existing._id, candidate);
    }
    return { acknowledged: true, matchedCount: matched.length, modifiedCount: matched.length };
  }

  async findOneAndUpdate(filter, update, options = {}) {
    const [existing] = sortDocuments(this.#matching(filter), options.sort);

    if (!existing) {
      if (!options.upsert) return options.includeResultMetadata ? { value: null } : null;
      const { upsertedId } = await this.updateOne(filter, update, { upsert: true });
      const created = this.documents.get(upsertedId);
      const value = project(created, options.projection);
      return options.includeResultMetadata ? { value } : value;
    }

    const before = clone(existing);
    const candidate = clone(existing);
    applyUpdate(candidate, update);
    this.#assertUnique(candidate, existing._id);
    this.documents.set(existing._id, candidate);

    const chosen = options.returnDocument === 'after' ? candidate : before;
    const value = project(chosen, options.projection);
    return options.includeResultMetadata ? { value } : value;
  }

  async deleteOne(filter) {
    const [existing] = this.#matching(filter);
    if (!existing) return { acknowledged: true, deletedCount: 0 };
    this.documents.delete(existing._id);
    return { acknowledged: true, deletedCount: 1 };
  }

  async deleteMany(filter = {}) {
    const matched = this.#matching(filter);
    for (const document of matched) this.documents.delete(document._id);
    return { acknowledged: true, deletedCount: matched.length };
  }

  aggregate(pipeline = []) {
    let documents = [...this.documents.values()].map(clone);

    for (const stage of pipeline) {
      const [operator, spec] = Object.entries(stage)[0];
      switch (operator) {
        case '$match':
          documents = documents.filter((document) => matchesFilter(document, spec));
          break;
        case '$sort':
          documents = sortDocuments(documents, spec);
          break;
        case '$limit':
          documents = documents.slice(0, spec);
          break;
        case '$skip':
          documents = documents.slice(spec);
          break;
        case '$project':
          documents = documents.map((document) => project(document, spec));
          break;
        case '$group': {
          const groups = new Map();
          for (const document of documents) {
            const key =
              typeof spec._id === 'string' && spec._id.startsWith('$')
                ? getPath(document, spec._id.slice(1))
                : spec._id;
            const serialised = JSON.stringify(key ?? null);
            if (!groups.has(serialised)) groups.set(serialised, { _id: key ?? null, __rows: [] });
            groups.get(serialised).__rows.push(document);
          }
          documents = [...groups.values()].map((group) => {
            const result = { _id: group._id };
            for (const [field, accumulator] of Object.entries(spec)) {
              if (field === '_id') continue;
              const [op, operand] = Object.entries(accumulator)[0];
              if (op === '$sum') {
                result[field] =
                  typeof operand === 'number'
                    ? group.__rows.length * operand
                    : group.__rows.reduce(
                        (total, row) => total + (getPath(row, String(operand).slice(1)) ?? 0),
                        0,
                      );
              } else if (op === '$first') {
                result[field] = getPath(group.__rows[0], String(operand).slice(1));
              } else if (op === '$max') {
                result[field] = group.__rows.reduce(
                  (best, row) => {
                    const value = getPath(row, String(operand).slice(1));
                    return best === undefined || compare(value, best) > 0 ? value : best;
                  },
                  undefined,
                );
              } else {
                throw new Error(`memory-db: unsupported accumulator "${op}"`);
              }
            }
            return result;
          });
          break;
        }
        default:
          throw new Error(`memory-db: unsupported aggregation stage "${operator}"`);
      }
    }

    return { toArray: async () => documents };
  }

  async createIndex() {
    return 'ok';
  }

  async createIndexes() {
    return 'ok';
  }

  async listIndexes() {
    return { toArray: async () => [] };
  }
}

export function createMemoryDb() {
  const collections = new Map();

  return {
    collection(name) {
      if (!collections.has(name)) collections.set(name, new MemoryCollection(name));
      return collections.get(name);
    },
    async command() {
      return { ok: 1 };
    },
    _collection(name) {
      return this.collection(name);
    },
    _reset() {
      collections.clear();
    },
  };
}

export { MemoryCollection };
