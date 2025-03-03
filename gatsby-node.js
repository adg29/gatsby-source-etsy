const { createRemoteFileNode } = require('gatsby-source-filesystem')
const { createThrottledFetch } = require('./utils')
const { ETSY_BASE_URL } = require('./constants')

const etsyFetch = createThrottledFetch({
  minTime: 150, // 6.7 requests per second
  maxConcurrent: 6,
})

exports.sourceNodes = async (
  {
    actions,
    cache,
    createContentDigest,
    createNodeId,
    getNode,
    reporter,
    store,
  },
  configOptions
) => {
  const { createNode, createParentChildLink, touchNode } = actions
  const { apiKey, shopId, language, limit } = configOptions

  // * Get the listings
  const { results: listings } = await etsyFetch(
    `${ETSY_BASE_URL}/shops/${shopId}/listings/active?api_key=${apiKey}${language ? `&language=${language}&limit=${limit ? limit : 25}` : ''}`
  ).then(res => res.json())

  // * Process listings
  const listingProcessingJobs = listings.map(async listing => {
    const { listing_id } = listing
    const listingNodeId = `gsetsy_listing_${listing_id}`

    // * Check if there is a cached node for this listing
    const { cachedListingNodeId, cachedImageNodeIds } =
      (await cache.get(`cached-${listingNodeId}`)) || {}
    const cachedListingNode = getNode(cachedListingNodeId)
    if (
      cachedListingNode &&
      cachedListingNode.last_modified_tsz === listing.last_modified_tsz
    ) {
      reporter.info(
        `gatsby-source-etsy: using cached version of listing node ${cachedListingNode.id}`
      )
      touchNode({ nodeId: cachedListingNode.id })
      cachedImageNodeIds.forEach(nodeId => touchNode({ nodeId }))
      return
    }

    reporter.info(
      `gatsby-source-etsy: cached listing node not found, downloading ${listingNodeId}`
    )

    // * Create a node for the listing
    await createNode({
      id: listingNodeId,
      parent: null,
      internal: {
        type: 'FeaturedEtsyListing',
        contentDigest: createContentDigest(listing),
      },
      ...listing,
    })

    // * Get images metadata for the listing
    const { results: images } = await etsyFetch(
      `${ETSY_BASE_URL}/listings/${listing_id}/images?api_key=${apiKey}`
    ).then(res => res.json())
    // * Process images
    const imageNodePromises = images.map(image => {
      return new Promise(async (resolve, reject) => {

        // * Create a node for each image
        const imageNodeId = `${listingNodeId}_image_${image.listing_image_id}`
        await createNode({
          id: imageNodeId,
          parent: listingNodeId,
          internal: {
            type: 'EtsyListingImage',
            contentDigest: createContentDigest(image),
          },
          ...image,
        })
        const listingNode = getNode(listingNodeId)
        const imageNode = getNode(imageNodeId)
        await createParentChildLink({
          parent: listingNode,
          child: imageNode,
        })
        // * Create a child node for each image file
        const url = image.url_fullxfull + `?lid=${listing_id}`
        const fileNode = await createRemoteFileNode({
          url,
          parentNodeId: imageNodeId,
          store,
          cache,
          createNode,
          createNodeId,
        })
        await createParentChildLink({
          parent: imageNode,
          child: fileNode,
        })
        const imageNodeWithFile = getNode(imageNodeId)
        resolve(imageNodeWithFile)
      })
    })
    const imageNodes = await Promise.all(imageNodePromises)
    const imageNodeIds = imageNodes.map(node => node.id)

    async function processListingInventory({listing_id, listingNodeId}) {
      // * Get inventory metadata for the listing
      const apiFetch = await etsyFetch(
        `${ETSY_BASE_URL}/listings/${listing_id}/inventory?api_key=${apiKey}`
      ).then(res => res.json())
      // * Process products
      if (apiFetch) {
        const { results: inventory } = apiFetch
        
        const productNodePromises = inventory.products.map(product => {
          return new Promise(async (resolve, reject) => {

            // * Create a node for each image
            const productNodeId = `${listingNodeId}_product_${product.product_id}`
            await createNode({
              id: productNodeId,
              parent: listingNodeId,
              internal: {
                type: 'EtsyListingInventory',
                contentDigest: createContentDigest(product),
              },
              ...product,
            })
            const listingNode = await getNode(listingNodeId)
            const productNode = await getNode(productNodeId)
            await createParentChildLink({
              parent: listingNode,
              child: productNode,
            })
            // * Create a child node for each product entry
            resolve(productNode)
          })
        })

        const productNodes = await Promise.all(productNodePromises)
        const productNodeIds = productNodes.map(node => node.id)

        return Promise.resolve(productNodeIds)
      }else{
        return Promise.resolve([])
      }
    }

    /** Get Inventory metadata for the listing */
    const productNodeIds = await processListingInventory({
      listing_id,
      listingNodeId
    })

    // * Cache the listing node id and image node ids
    await cache.set(`cached-${listingNodeId}`, {
      cachedListingNodeId: listingNodeId,
      cachedImageNodeIds: imageNodeIds,
      cachedProductIds: productNodeIds
    })
  })
  return Promise.all(listingProcessingJobs)
}