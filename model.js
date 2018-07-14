/*
  model.js

  This file is required. It must export a class with at least one public function called `getData`

  Documentation: http://koopjs.github.io/docs/specs/provider/
*/
const request = require('request-promise').defaults({gzip: true, json: true})
const config = require('config') // not using this, wasn't sure if this was a standard practice for config, see below
// This could go up in config, putting this here for now, alternatively this could be passed as the hosts? parameter
let domain = 'data.sfgov.org'
// for the license information, also could be part of config, but would have to be mapped to a domain, skipped if not available
const organization = 'the City and County of San Francisco'

function Model (koop) {}

// Public function to return data from the
// Return: GeoJSON FeatureCollection
//
// Config parameters (config/default.json)
// req.
//
// URL path parameters:
// req.params.host (if index.js:hosts true)
// req.params.id  (if index.js:disableIdParam false)
// req.params.layer
// req.params.method
Model.prototype.getData = function (req, callback) {
  // store 2 ids, first one for data, second one for metadata, these are different for certain Socrata geo types
  let ids = [req.params.id, req.params.id]
  domain = req.params.host || domain
  // Account for parent child maps in Socrata - the parent will have the metadata, the child will have the 2.1 data endpoint
  request(`https://${domain}/api/views/${req.params.id}.json`)
    .then((body) => {
      // id only reset if there's a child view detected
      if (body.childViews) ids[0] = body.childViews[0]
      // if the dataset has a parent, use that for the metadata
      if (body.privateMetadata && body.privateMetadata.geo && body.privateMetadata.geo.parentUid) ids[1] = body.privateMetadata.geo.parentUid 
      // get data, try again with nbeId if encounter a 400 error
      let qs = formatQuery(req.query)
      processData(ids, qs, {statusCode: 400, handleError: catch400}, callback)
    })
    .catch((err) => {
      if(err.statusCode === 404) {
        catchNotFound(err, ids, callback)
      } else {
        callback(new Error(`${err.statusCode} - Unexpected problem, cannot reach server`))
      }
    })
  }

  function formatQuery(query) {
    let qs = []
    qs.push('$select=:*,*')
    if (query.where) qs.push('$where=' + query.where)
    if (query.resultOffset) qs.push('$offset=' + query.resultOffset)
    if (query.resultRecordCount) qs.push('$limit=' + query.resultRecordCount)
    if (query.orderByFields) {
      query.orderByFields.split(',').split(' ')
    } else {
      qs.push('$order=:id+asc')
    }
    return qs.join('&')
  }

  function processData(ids, qs, onError, callback) {
    let id = ids[0]
    let metadataId = ids[1]
    console.log(`calling https://${domain}/resource/${id}.geojson?${qs}`)
    Promise.all([
      request(`https://${domain}/resource/${id}.geojson?${qs}`),
      // This gives us the column info so we can grab the field name corresponding to geometry
      request(`https://${domain}/api/views.json?method=getByResourceName&name=${id}`)
    ]).then((data) => {
      let geojson = data[0]
      // get column with geometry
      let geoField = data[1].columns.filter((val) => {
        return ['point','line','polygon','multipoint','multiline','multipolygon'].indexOf(val.dataTypeName) > -1
      })
      Promise.all([
        requestMetadata(metadataId), 
        requestExtent(id, geoField)
      ]).then(([{name, description, license},extent]) => {
          geojson.metadata = {
            idField: ':id',
            name,
            description,
            // doesn't look like copyrightText is passed along to the FeatureService metadata, could add it to the description for now
            copyrightText: `This data licensed by ${organization} under ${license}`,
            //maxRecordCount: 1000,
            extent
          }
          callback(null, geojson)
        })
        .catch((err) => {
          console.error(err)
          // if metadata api errors, still return the original data w/o metadata
          callback(null, geojson)
        })
      })
      .catch((err) => {
        if(err.statusCode === onError.statusCode) {
          onError.handleError(err, ids, qs, callback)
        } else if (err.statusCode === 404) {
          catchNotFound(err, ids, callback)
        } else {
          callback(err)
        }
      })
  }

  const requestMetadata = id => request(`https://${domain}/api/views/metadata/v1/${id}.json`)

  function requestExtent(id, geom) {
    if (geom.length > 0) {
      let geoField = geom[0].fieldName
      return request(`https://${domain}/resource/${id}.geojson?$select=extent(${geoField})`).then((extent) => {
        let extentArray = extent.features[0].geometry.coordinates[0][0].reduce((acc, curr) => {
          let newExtent = []
          if (acc.length === 0) {
            newExtent = [[curr[0], curr[1]],[curr[0], curr[1]]]
          } else {
            newExtent = [
              [Math.min(acc[0][0], curr[0]), Math.min(acc[0][1], curr[1])],
              [Math.max(acc[1][0],curr[0]),Math.max(acc[1][1], curr[1])]
            ]
          }
          return newExtent
        },[])
        return extentArray
      })
    } else {
      return null
    }
  }

  function catch400(err, ids, qs, callback) {
    // 400 when calling a geojson endpoint normally means we're not using the right ID
    // We can get it from the migrations api and process the returned data
    // Ideally, the user just uses the nbeId, but it can be confusing which ID to use so this should take care of this
    request(`https://${domain}/api/migrations/${ids[0]}.json`)
      .then((body) => {
        ids[0] = body.nbeId
        processData(ids, qs, {statusCode: 404, handleError: catchNotFound}, callback)
      })
  }

  function catchNotFound(err, ids, callback) {
    // end of the line, pass error to callback
    // Question: what's the best practice here? I passed in the err but it came out unintelligible, can I pass something that will be more meaningful to the end user, the json comes through but it still comes through with a 200 for example
    callback(new Error(`404 - Dataset for id ${ids[0]} not found on this domain`))
  }
  
module.exports = Model

/*
Feature service metadata
metadata: {
    name: String, // The name of the layer
    description: String, // The description of the layer
    extent: Array, // valid extent array e.g. [[180,90],[-180,-90]]
    displayField: String, // The display field to be used by a client @question: we can probably set this somewhere and query it, but it'll be very specific to our use in SF
    geometryType: String // REQUIRED if no features are returned with this object Point || MultiPoint || LineString || MultiLineString || Polygon || MultiPolygon
    idField: String, // unique identifier field,
    maxRecordCount: Number, // the maximum number of features a provider can return at once, @question: technically no limit on Socrata's side, but maybe want to keep this reasonable, will ArcMap automatically query them a little at a time??
    limitExceeded: Boolean, // whether or not the server has limited the features returned
    timeInfo: Object // describes the time extent and capabilities of the layer, @question: what's timeInfo object??
    fields: [
     { // Subkeys are optional
       name: String,
       type: String, // 'Date' || 'Double' || 'Integer' || 'String'
       alias: String, // how should clients display this field name,
     }
    ]
  }
*/
