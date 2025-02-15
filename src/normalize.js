import { has, isObject } from 'lodash/fp';
import { createRemoteFileNode } from 'gatsby-source-filesystem';
import { Parser } from 'commonmark';

const reader = new Parser();

const isImage = has('mime');
const getUpdatedAt = (image) => image.updatedAt || image.updated_at;

function markdownImages(options, type) {
  const typesToParse = options.typesToParse || {};
  const fieldsToParse = typesToParse[type] || [];

  const shouldParseForImages = (item) =>
    Object.keys(item).some((key) => fieldsToParse.indexOf(key) > -1);

  return {
    shouldParseForImages,
    fieldsToParse,
  };
}

const extractImage = async (image, ctx) => {
  const { apiURL, store, cache, createNode, createNodeId, touchNode, getNode, jwtToken } = ctx;

  let fileNodeID;

  // using field on the cache key for multiple image field
  const mediaDataCacheKey = `strapi-media-${image.id}`;
  const cacheMediaData = await cache.get(mediaDataCacheKey);

  // If we have cached media data and it wasn't modified, reuse
  // previously created file node to not try to redownload
  if (cacheMediaData && getUpdatedAt(image) === cacheMediaData.updatedAt) {
    fileNodeID = cacheMediaData.fileNodeID;
    touchNode(getNode(fileNodeID));
  }

  // If we don't have cached data, download the file
  if (!fileNodeID) {
    // full media url
    const source_url = `${image.url.startsWith('http') ? '' : apiURL}${image.url}`;
    const fileNode = await createRemoteFileNode({
      url: source_url,
      store,
      cache,
      createNode,
      createNodeId,
      auth: jwtToken,
    });

    if (fileNode) {
      fileNodeID = fileNode.id;

      await cache.set(mediaDataCacheKey, {
        fileNodeID,
        updatedAt: getUpdatedAt(image),
      });
    }
  }

  if (fileNodeID) {
    image.localFile___NODE = fileNodeID;
  }
};

const parseImagesFromMarkdown = async (item, ctx, key) => {
  const field = item[key];
  if (!field) return;
  const parsed = reader.parse(field);
  const walker = parsed.walker();
  let event, node;

  while ((event = walker.next())) {
    node = event.node;
    // process image nodes
    if (event.entering && node.type === 'image') {
      let fileNodeID, fileNodeBase;
      const filePathname = node.destination;

      // using filePathname on the cache key for multiple image field
      const mediaDataCacheKey = `strapi-media-${item.id}-${filePathname}`;
      const cacheMediaData = await ctx.cache.get(mediaDataCacheKey);

      // If we have cached media data and it wasn't modified, reuse
      // previously created file node to not try to redownload
      if (cacheMediaData) {
        fileNodeID = cacheMediaData.fileNodeID;
        fileNodeBase = cacheMediaData.fileNodeBase;
        ctx.touchNode(ctx.getNode(fileNodeID));
      }

      if (!fileNodeID) {
        try {
          // full media url
          const source_url = `${filePathname.startsWith('http') ? '' : ctx.apiURL}${filePathname}`;

          const fileNode = await createRemoteFileNode({
            url: source_url,
            store: ctx.store,
            cache: ctx.cache,
            createNode: ctx.createNode,
            createNodeId: ctx.createNodeId,
            auth: ctx.jwtToken,
          });

          // If we don't have cached data, download the file
          if (fileNode) {
            fileNodeID = fileNode.id;
            fileNodeBase = fileNode.base;

            await ctx.cache.set(mediaDataCacheKey, {
              fileNodeID,
              fileNodeBase,
            });
          }
        } catch (e) {
          // Ignore
        }
      }
      if (fileNodeID) {
        // create an array of parsed and downloaded images as a new field
        if (!item[`${key}_images___NODE`]) {
          item[`${key}_images___NODE`] = [];
        }
        item[`${key}_images___NODE`].push(fileNodeID);

        // replace filePathname with the newly created base
        // useful for future operations in Gatsby
        item[key] = item[key].replace(filePathname, fileNodeBase);
      }
    }
  }
};

const extractFields = async (item, ctx, entityType) => {
  const existingEntityType = ctx.types.find((el) => el.name === entityType);
  const { shouldParseForImages, fieldsToParse } = markdownImages(
    ctx.markdownImages,
    existingEntityType?.name || undefined
  );

  if (isImage(item)) {
    return extractImage(item, ctx);
  }

  if (Array.isArray(item)) {
    for (const element of item) {
      await extractFields(element, ctx);
    }

    return;
  }

  if (isObject(item)) {
    for (const key in item) {
      if (shouldParseForImages(item) && fieldsToParse.includes(key)) {
        await parseImagesFromMarkdown(item, ctx, key);
      }
      await extractFields(item[key], ctx);
    }

    return;
  }
};

exports.isDynamicZone = (node) => {
  // Dynamic zones are always arrays
  if (Array.isArray(node)) {
    return node.some((nodeItem) => {
      // The object is a dynamic zone if it has a strapi_component key
      return has('strapi_component', nodeItem);
    });
  }
  return false;
};

// Downloads media from image type fields
exports.downloadMediaFiles = async (entities, ctx, entityType) => {
  return Promise.all(entities.map((entity) => extractFields(entity, ctx, entityType)));
};
