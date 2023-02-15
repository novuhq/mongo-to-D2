import { readFileSync, writeFileSync} from 'fs';
import {MongoClient, ObjectId, Long } from 'mongodb';
import { execFileSync } from "child_process";
import * as eta from "eta";

const template = readFileSync("./template.eta").toString();

async function listDatabases(client){
  let databasesList = await client.db().admin().listDatabases();

  let dbList = databasesList.databases.filter(function (val) {
    if (val.name !== "local" && val.name !== "config" && val.name !== "admin" ) {
      return val
    }
  })

  console.log("Databases:");
  dbList.forEach(db => console.log(` - ${db.name}`));
  return dbList;
}

function reduceElement(element, schema) {

  for (const key of Object.keys(element)) {
    if (!(key in schema)) {

      let type = fieldTypeOf(element[key.toString()])

      if (type === 'Object') {
        schema[key.toString()] = {}
        reduceElement(element[key.toString()], schema[key.toString()] )

      } else if (type === 'Array') {

        if ( (element[key.toString()].length === 0 || element[key.toString()][0] === 'undefined') && !(schema[key.toString()] instanceof Object) ) {

          schema[key.toString()] = type + ' - undefined';

        } else if (fieldTypeOf(element[key.toString()][0]) === 'Object') {

          schema[key.toString()] = {}

          reduceDocuments(element[key.toString()], schema[key.toString()] )

        } else {
          schema[key.toString()] = type + ' - ' + fieldTypeOf(element[key.toString()][0]);
        }

      } else if (type === 'ObjectId' && key !== "_id" && key.endsWith("Id") && key.startsWith("_")){
        // parse name and add to list to check if the table actually exists later

        const parsedTableName = key.replace("_","").substring(0, key.length - 3)

        if (schema['relations'] === undefined) {
          schema['relations'] = []
        }

        if (! schema['relations'].includes(parsedTableName)) {
          schema['relations'].push(parsedTableName)
          schema['relations'].push(parsedTableName + "s")
        }
      } else {

        schema[key.toString()] = type

      }

    } // if

  }// for

}

function reduceDocuments(documentList, schema){

  for (const doc of documentList) {

    reduceElement(doc,schema)

  }
}

function fieldTypeOf(thing) {
  if (!arguments.length) { throw 'varietyTypeOf() requires an argument'; }

  if (typeof thing === 'undefined') {
    return 'undefined';
  } else if (typeof thing !== 'object') {
    // the messiness below capitalizes the first letter, so the output matches
    // the other return values below. -JC
    const typeofThing = typeof thing; // edgecase of JSHint's "singleGroups"
    return typeofThing[0].toUpperCase() + typeofThing.slice(1);
  } else {
    if (thing && thing.constructor === Array) {
      return 'Array';
    } else if (thing === null) {
      return 'null';
    } else if (thing instanceof Date) {
      return 'Date';
    } else if(thing instanceof Long) {
      return 'NumberLong';
    } else if (thing instanceof ObjectId) {
      return 'ObjectId';
    // } else if (thing instanceof BSON.BSONType) {
    //   const binDataTypes = {};
    //   binDataTypes[0x00] = 'generic';
    //   binDataTypes[0x01] = 'function';
    //   binDataTypes[0x02] = 'old';
    //   binDataTypes[0x03] = 'UUID';
    //   binDataTypes[0x04] = 'UUID';
    //   binDataTypes[0x05] = 'MD5';
    //   binDataTypes[0x06] = 'Encrypted-BSON';
    //   binDataTypes[0x07] = 'time-series';
    //   binDataTypes[0x80] = 'user';
    //   return 'BinData-' + binDataTypes[thing.subtype()];
    } else {
      return 'Object'
    }
  }
}

function checkRelations(schema){

  for (const db of Object.keys(schema)) {

    for (const table of Object.keys(schema[db])) {

      if (schema[db][table]['relations'] !== undefined) {
        let removeList = []

        for (const relation of schema[db][table]['relations']) {

          if (!Object.keys(schema[db]).includes(relation)) {
            removeList.push(relation)
          }
        }

        for (const removeListElement of removeList) {
          schema[db][table]['relations'].splice(schema[db][table]['relations'].indexOf(removeListElement), 1)
        }

      }// if
    } // for
  } // for
}


const args = process.argv.slice(2);

async function getSchema() {
  let connectionString = "mongodb://localhost:27017"
  if (args[0]){
    connectionString = args[0]
  }

  const client = new MongoClient(connectionString);

  await client.connect();

  let dbList = await listDatabases(client);

  if (dbList.length === 0 ){
    console.log("Unable to find any databases to diagram")
    process.exit(1);
  }

  let pipeline = [
    {
      $sample:
      /**
       * size: The number of documents to sample.
       */
          {
            size: 1000,
          },
    },
  ]

  let schema = {}

  for (const database of dbList) {
    schema[database.name.toString()] = {};

    let collectionList = (await client.db(database.name.toString()).listCollections().toArray()).filter(obj => obj.type === "collection");

    for (const collection of collectionList) {
      const samples = await client.db(database.name).collection(collection.name).aggregate(pipeline).toArray();

      schema[database.name][collection.name] = {}

      reduceDocuments(samples, schema[database.name][collection.name]);
    }
  }

  checkRelations(schema)



  return schema
}

async function main() {
  const schema = await getSchema();
  const output = await eta.render(template, {schema});

  writeFileSync("output.d2", output);
  execFileSync("d2", ["output.d2", "out.svg"]);

  process.exit(0);

}

main();
