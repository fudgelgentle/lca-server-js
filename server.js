// ! commonJS
const OpenAI = require('openai');
const express = require('express');
const axios = require('axios');
const pdf = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const cheerio = require('cheerio');
const app = express();
const { MongoClient, ObjectId } = require('mongodb');

// Middleware to parse JSON
app.use(express.json());

// set up static content
app.use(express.static('public'));

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// Allow all origins.
app.use(cors());

// Paths to the JSON files
const airDataFilePath = path.join(__dirname, 'public', 'data', 'air-map-data.json');
const groundDataFilePath = path.join(__dirname, 'public', 'data', 'ground-map-data.json');
const phoneDataFilePath = path.join(__dirname, 'public', 'data', 'phone-data.json');
const gptPromptDataFilePath = path.join(__dirname, 'public', 'prompt', 'extract_LCA_sources_prompt_v4.txt');

const archiveFilePath = path.join(__dirname, 'public', 'prompt', 'archive.txt');

const MONGO_URI = 'mongodb+srv://pu098:Zvn6PmpY3OjDOi48@lcavizdb.nuhl4.mongodb.net/?retryWrites=true&w=majority&appName=lcavizdb';

const client = new MongoClient(MONGO_URI);

/**
 * !Don't delete this function
 * Adds the normalized_name property to every entries of the phone database
 */
async function addNormalizedName() {
  try {
      const db = await connectToDB();
      const collection = db.collection("devices");
      // Add 'normalized_name' field to all documents
      const cursor = collection.find();
      while (await cursor.hasNext()) {
          const document = await cursor.next();
          const normalizedName = normalizeDeviceName(document.device);
          // Update the document with the normalized_name field
          await collection.updateOne(
              { _id: document._id }, // Filter by document's unique ID
              { $set: { normalized_name: normalizedName } } // Add normalized_name field
          );
          console.log(`Updated document ${document._id} with normalized_name: ${normalizedName}`);
      }
  } catch (error) {
      console.error("Error updating documents:", error);
  } finally {
      await client.close();
  }
}

/**
 * Establishes a connection with phone-carbon-data database and returns the db instance
 * @returns the database db
 */
async function connectToDB() {
  try {
    await client.connect();
    console.log('connected to MongoDB');
    return client.db("phone-carbon-data");
  } catch (error) {
    console.log(error);
  }
}

/**
 * Takes in the phone carbon data and inserts that into the devices collection
 * @param {Object} data the phone carbon data
 */
async function insertDevices(data) {
  try {
    const db = await connectToDB();
    const collection = db.collection("devices");
    const result = await collection.insertOne(data);
    console.log("Data inserted with ID:", result.insertedId);
  } catch (error) {
    console.log(error);
  }
}

/**
 * Retrieves all data from the 'devices' collection of 'lcavizdb' and return it as a JSON
 * @returns a JSON data containing all phone carbon info
 */
async function getDevicesData() {
  try {
    const db = await connectToDB();
    const collection = db.collection("devices");
    const data = await collection.find({}).toArray();
    return data;
  } catch (error) {
    console.log(error);
    return null;
  }
}

/**
 * Takes in a normalized device name and deletes that entry from the database
 * @param {String} normalizedDeviceName The normalized device name
 */
async function deleteData(normalizedDeviceName) {
  try {
    const db = await connectToDB();
    const collection = db.collection("devices");
    const result = await collection.deleteOne({ normalized_name: normalizedDeviceName });
    console.log("Number of documents deleted:", result.deletedCount);
  } catch (error) {
    console.log(error);
  }
}

// Function to read data from a JSON file
function readDataFromFile(filePath) {
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error(`Error reading file ${filePath}:`, err);
    return {};
  }
}

// Load initial data
let mapAirData = readDataFromFile(airDataFilePath);
let mapGroundData = readDataFromFile(groundDataFilePath);

// Serve the index.ejs file
app.get('/', (req, res) => {
  res.render('index');
});

/**
 * Takes in shipping information and uses climatiq API to calculate the corresponding carbon emissions
 */
app.post('/api/freight', async (req, res) => {
  const url = 'https://api.climatiq.io/freight/v2/intermodal';
  const apiKey = process.env.CLIMATIQ_API_KEY;
  const data = req.body;

  try {
    const response = await axios.post(url, data, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error('Error making request:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Takes in an input text and returns a JSON extracting the raw materials, transport, or use/energy from the text.
 */
app.post('/api/evaluate-text', async (req, res) => {
  const inputText = req.body.text;
  if (!inputText || typeof inputText !== 'string') {
    return res.status(400).json({ error: 'Invalid input text' });
  }

  try {
    const updatedPrompt = await extractSourcesFromText(inputText);
    const context = "You are a professional environmental scientist and life-cycle assessment (LCA) engineer.";
    let responseMessage = await getCompletion(updatedPrompt, context);

    // Remove markdown-style formatting from the message
    responseMessage = responseMessage.replace(/```json|```/g, '');
    console.log('responseMessage = ', responseMessage);

    let parsedJson = JSON.parse(responseMessage);
    if (!parsedJson) {
      parsedJson = { data: "null" };
    }
    console.log('parsedJson = ', parsedJson);
    res.json(parsedJson);
  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Takes in product_name and returns a JSON of the product's carbon emissions. This is used with phone models
 */
app.post('/api/product-emissions', async (req, res) => {
  try {
    const productName = req.body.product_name;
    console.log('PRODUCT NAME = ' + productName);
    const parsedJson = await findOrAddDeviceToDatabase(productName);
    res.send(parsedJson);
  } catch (error) {
    console.log(error);
    return [];
  }
});

/**
 * Takes in product_name and returns a JSON containing the carbon information of the recommended devices based on the product_name
 */
app.post('/api/product-recommendations', async (req, res) => {
  try {
    const productName = req.body.product_name;
    console.log('PRODUCT NAME = ' + productName);
    const recommendedModels = await recommendModels(productName);
    recommendedModels.forEach((phone, index) => {
      phone.index = index;
    });
    await client.close();
    res.json(recommendedModels);
  } catch (error) {
    console.log(error);
  }
});

// Endpoint to retrieve the JSON phone data
app.get('/get-phone-data', (req, res) => {
  try {
    const data = fs.readFileSync(phoneDataFilePath, 'utf8');
    const jsonData = JSON.parse(data);
    res.json(jsonData);
  } catch (error) {
    console.error('Error reading air-map-data.json:', error.message);
    res.status(500).json({ error: 'Failed to retrieve air map data' });
  }
});

// Converts a Google sustainability report URL to a direct PDF link
function convertGoogleReportUrl(url) {
  // Split the URL by slashes, filter out any empty parts, and take the last item
  const parts = url.split('/').filter(part => part !== '');
  const reportName = parts.pop();
  console.log('REPORT NAME = ' + reportName);
  const newUrl = `https://www.gstatic.com/gumdrop/sustainability/${reportName}.pdf`;
  return newUrl;
}

// Searches for Product Carbon Footprint (PCF) reports on Google and returns processed document URLs
async function productPCFGoogleSearch(productName, numResults = 2) {
  const queries = [
    `Carbon Footprint of ${productName}`
  ];
  const urls = [];
  let start = new Date().getTime();
  for (const query of queries) {
    const searchResults = await googleSearch(query, numResults);
    for (const url of searchResults) {
      if (productName.includes('Google') && url.includes('sustainability.google/reports/')) {
        urls.push(convertGoogleReportUrl(url));
      } else {
        urls.push(url);
      }
    }
  }
  let end = new Date().getTime();
  console.log(`Google Search: ${(end - start) / 1000} seconds`);
  start = new Date().getTime();
  const documents = await loadDocumentsFromUrls(urls);
  end = new Date().getTime();
  console.log(`Doc load: ${(end - start) / 1000} seconds`);

  return documents;
}

// Fetch search results from Google using google custom search API
async function googleSearch(query, numResults) {
  console.log('QUERY = ' + query);
  const apiKey = 'AIzaSyALHUDzdaM9VT9Pmwt4aZw8Q6FWTSV1hpw';
  const cx = '649159098969f4cff';

  // const pdfQuery = `${query} filetype:pdf`;
  const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(query)}&num=${numResults}`;

  const response = await fetch(searchUrl);
  const data = await response.json();
  return data.items.map(item => item.link);
}

/**
 * Takes in a phone name, checks if that phone exists in the phone database, then returns the phone carbon data
 * @param {String} targetPhoneName The phone to check
 * @returns Returns the carbon data of that phone if it exists, returns null otherwise.
 */
async function checkPhoneExists(targetPhoneName) {
  try {
    const db = await connectToDB();
    const collection = db.collection("devices");

    const normalizedTarget = normalizeDeviceName(targetPhoneName);
    console.log('normalized target: ' + normalizedTarget);
    const existingPhone = await collection.findOne({ normalized_name: normalizedTarget });

    return existingPhone;
  } catch (error) {
    console.log(error);
    return null;
  }
}

/**
 * Takes in a phone carbon data object, and returns an array containing the carbon data of the competitors of that phone.
 * @param {Object} existingPhoneObject The existing phone object
 * @returns {Array} An object array containing the carbon data of the competitors of that phone.
 */
async function getCompetitors(existingPhoneObject) {
  if (!existingPhoneObject || !existingPhoneObject.competitors || existingPhoneObject.competitors.length < 1) {
    return [];
  }
  try {
    const db = await connectToDB();
    const collection = db.collection("devices");

    const competitorEntries = await collection
            .find({ _id: { $in: existingPhoneObject.competitors.map(id => new ObjectId(id)) } })
            .toArray();

    return competitorEntries;
  } catch (error) {
    console.log(error);
  }
}

/**
 * Takes an existing phone object and an array of competitor names, and adds the 'competitors' field to the existing phone object containg the id of each competitor
 * @param {Object} existingPhoneObject The existing phone object
 * @param {Array} competitorNames An array of competitor names, for example: arr = ["Samsung Z Flip6", "Google Pixel 8 Pro"]
 */
async function addCompetitors(existingPhoneObject, competitorNames) {
  if (!existingPhoneObject || !existingPhoneObject._id) {
    console.log("Invalid existingPhone object.");
    return;
  }
  try {
    const db = await connectToDB();
    const collection = db.collection('devices');
    const normalizedCompetitorNames = competitorNames.map(normalizeDeviceName);

    const matchingCompetitors = await collection
        .find({ normalized_name: { $in: normalizedCompetitorNames } })
        .toArray();

    if (matchingCompetitors.length === 0) {
      console.log("No matching competitors found in the database.");
      return;
    }
    const competitorIds = matchingCompetitors.map(competitor => competitor._id);

    const result = await collection.updateOne(
      { _id: existingPhoneObject._id },
      { $addToSet: { competitors: { $each: competitorIds } } }
    );
    console.log(`Updated ${result.modifiedCount} document(s).`);
  } catch (error) {
    console.log(error);
  }
}

/**
 * Takes in the product name and returns an array containing JSON carbon information of the models that are recommended based on OpenAI API results.
 * @param {String} phoneName The phone name
 * @returns An array containing JSON carbon information of the models that are recommended based on OpenAI API results.
 */
async function recommendModels(phoneName) {
  console.log('finding recommendations for: ' + phoneName);
  const phoneObject = await checkPhoneExists(phoneName);
  if (phoneObject) {
    let competitorsList = await getCompetitors(phoneObject);
    // !There should be at least 2 phone recommendations. This is a safeguard in case the GPT prompt gave us 1 recommended phone
    if (competitorsList.length > 1) {
      return competitorsList;
    } else {
      console.log(`Less than 2 competitors found on ${phoneName}. Running recommendation prompt..`);
      const recommendationPrompt = `
        Given a phone model name, ${phoneName}, recommend two similar smartphone models from other well-known brands, like Google.
        Your recommendations should have similar prices and specifications, focusing on models with comparable features, performance, and popularity.
        Use your most up-to-date knowledge and provide the brand, model name, and a brief comparison of key specifications (such as processor, camera, and display) to highlight similarities.
        Ensure the recommendations are recent models that would appeal to users considering the specified phone. Provide your response in the following JSON format:

        Required JSON format:
        {
          "recommendations": [
            { "device": "<brand and model name>", "comparison": "<brief comparison>" },
            { "device": "<brand and model name>", "comparison": "<brief comparison>" }
          ]
        }
      `;
      const context = "You are an expert in consumer electronics, specializing in recommending comparable products across major categories such as smartphones, laptops, cameras, smartwatches, and tablets."

      let responseMessage;
      try {
        responseMessage = await getCompletion(recommendationPrompt, context);
      } catch (error) {
        console.error("Error fetching recommendations:", error);
        return;
      }

      responseMessage = responseMessage.replace(/```json|```/g, '');
      let response = JSON.parse(responseMessage);
      console.log('recommendedList = ');
      console.log(response);

      const competitorsList = [];
      for (const entry of response.recommendations) {
        const model = entry.device;
        const competitorName = await findOrAddDeviceToDatabase(model);
        competitorsList.push(competitorName);
      }
      const competitorNameList = response.recommendations.map((entry) => entry.device);
      await addCompetitors(phoneObject, competitorNameList);

      competitorsList.forEach((r, index) => {
        r.id = index;
      });
      return competitorsList;
    }
  } else {
    console.error(`Cannot find ${phoneName} in the phone database`);
  }
}

/**
 *
 * @param {String} productName e.g. "iPhone 15"
 * @param {*} documents The text file of the document containing the product's PCF information
 * @returns a JSON format containing the product and its corresponding carbon emissions
 */
async function analyzeEnvironmentalReports(productName, documents) {
  // Combine all the document contents into a single prompt
  const combinedDocuments = documents.map(doc => `Content from ${doc.url}:\n${doc.content}`).join('\n\n');
  const urlString = documents.map(doc => doc.url).toString();
  const cleanDocument = getRelevantCarbonInfo(combinedDocuments);
  fs.writeFileSync(archiveFilePath, cleanDocument, 'utf8');
  const context = "You are a professional environmental scientist and an SEO assistant.";

  const prompt = `
    Analyze the device '${productName}' with a focus on SEO and environmental impact. Based on the parsed webpage content below, provide a structured response in JSON format.

    Required JSON format:
    {
      "device": "<phone_model>",
      "base_co2e": "<carbon_emissions>",
      "source": "<source>",
      "method": "<method>"
      "specs": [
        {
          "storage": "<storage_space>"
        },
        ...
      ]
    }

    - **device**: Use the device name '${productName}'. If two devices are found, choose the first device.
    - **base_co2e**: Identify the product's carbon footprint (PCF) in kg CO2-eq per unit. If multiple PCF's are found, choose the lowest PCF value. If a specific PCF is not available from the content, infer an approximate carbon emission based on current knowledge. You must return an integer or float.
    - **source**: Use the relevant urls in this list: ${urlString}. The parsed webpage content are from these urls. If the carbon emissions were inferred and not from the content, include your own source instead.
    - **method**: Either put in 'inferred' or 'given'. 'inferred' means you inferred the carbon emissions. 'given' means you found the information from the given content.
    - **specs**: List all storage options for the device, in GB.

    **Example:**
    Example output:
    {
      "device": "Google Pixel 8 Pro",
      "base_co2e": 79,
      "source": "https://www.gstatic.com/gumdrop/sustainability/pixel-8-pro-product-enviromental-report.pdf",
      "specs": [
        {
          "storage": "128 GB"
        },
        {
          "storage": "256 GB"
        }
      ]
    }

    Content to analyze: \`\`\`${cleanDocument}\`\`\`
  `;

  // Get completion from OpenAI
  let result;
  try {
    result = await getCompletion(prompt, context);
  } catch (error) {
    console.error(error);
    return;
  }
  return result;
}

/**
 * Takes in the HTML or .pdf content of the PCF and returns a text string containing only the relevant carbon information of the product's PCF.
 * @param {String} content The HTML or .pdf content of the PCF
 * @returns An text string containing only the relevant carbon information of the product's PCF.
 */
function getRelevantCarbonInfo(content) {
  // Step 1: Clean the content using regular expressions
  const cleanedContent = content
      .replace(/<[^>]*>/g, '') // Remove HTML tags
      .replace(/\[.*?\]/g, '') // Remove footnotes or bracketed text
      .replace(/^\s*[\r\n]/gm, '') // Remove empty lines
      .replace(/\t+/g, ' ') // Replace tabs with a single space
      .replace(/\n+/g, ' ') // Replace newlines with a single space
      .replace(/\s{2,}/g, ' ') // Replace multiple spaces with a single space
      .trim();

  // Step 2: Define keywords for CO2e-related information
  const keywords = [
      'CO2e',
      'kg CO2e',
  ];
  const normalizedKeywords = keywords.map(keyword =>
    keyword.replace(/\s+/g, '').toLowerCase()
  );

  // Step 3: Analyze the content for keywords and extract relevant sections
  const relevantSections = [];
  const words = cleanedContent.split(/\s+/); // Split content into words
  let skipUntil = -1;

  words.forEach((_, index) => {

    // Skip words if within the skip range
    if (index <= skipUntil) {
      return;
    }
    // Create a "section" string from 100 words before and after
    const start = Math.max(0, index - 100);
    const end = Math.min(words.length, index + 100);
    const section = words.slice(start, end).join(' ');

    // Normalize the section for comparison
    const normalizedSection = section.replace(/\s+/g, '').toLowerCase();

    // Check if the normalized section contains any normalized keyword
    if (normalizedKeywords.some(keyword => normalizedSection.includes(keyword))) {
        relevantSections.push(section);
        // If a keyword is found, skip the next 100 words before analyzing again.
        skipUntil = index + 100;
    }
  });
  return relevantSections.join('\n\n');
}

/**
 * Loads content from the provided URLs using Puppeteer.
 * @param {Array} urls - List of URLs to load.
 * @returns {Array} documentsArr - Array of document contents loaded from each URL.
*/
async function loadDocumentsFromUrls(urls) {
  console.log('urls = ' + urls)
  const documentsArr = [];

  for (let url of urls) {
    try {
      if (url.endsWith('.pdf')) {
        // * Implementation with axios
        const start = Date.now();
        const response = await axios.get(url, { responseType: 'arraybuffer'});
        const data = await pdf(response.data);
        const content = data.text;
        const end = Date.now();
        console.log('Fetched PCF Data:', content);
        console.log(`Document Load Time: ${end - start} ms`);
        documentsArr.push({ url, content });
      } else {
        console.log('TEXT/HTML detected');
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);
        const content = $('body').text();
        documentsArr.push({ url, content });
      }
    } catch (error) {
      console.error(`Error scraping content from ${url}:`, error);
    }
    return documentsArr;
  }
}

/**
 * Takes in two locations (from, to) and returns the driving distance between them
 */
app.post('/api/travel-time', async(req, res) => {
  const url = "https://maps.googleapis.com/maps/api/distancematrix/json";
  const apiKey = process.env.GOOGLE_API_KEY;
  const from = req.body.from;
  const to = req.body.to;
  try {
    const response = await axios.get(url, {
      params: {
        origins: from,
        destinations: to,
        travelMode: 'DRIVING',
        units: 'imperial',
        key: apiKey
      }
    });
    res.json(response.data);
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Takes in cloud information and uses climatiq API to return its corresponding carbon emissions
 */
app.post('/api/cloud', async(req, res) => {
  const url = 'https://api.climatiq.io/compute/v1/azure/instance';
  const apiKey = process.env.CLIMATIQ_API_KEY;
  const data = req.body;
  try {
    const response = await axios.post(url, data, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    res.json(response.data);
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: error.message });
  }
})

//& ********* This part is for Google Maps *************

/**
 * Takes in data used for creating air map and writes that data into air-map-data.json
 */
app.post('/post-google-maps-air', (req, res) => {
  mapAirData = req.body;
  try {
    // Write the data to the JSON file
    fs.writeFileSync(airDataFilePath, JSON.stringify(mapAirData, null, 2), 'utf8');
    res.sendStatus(200);
  } catch (error) {
    console.error('Error writing to air-map-data.json:', error.message);
    // Send an error response
    res.status(500).json({ error: 'Failed to update air-map-data.json' });
  }
});

/**
 * Takes in data used for creating ground map and writes that data into ground-map-data.json
 */
app.post('/post-google-maps-ground', (req, res) => {
  mapGroundData = req.body;
  try {
    // Write the data to the JSON file
    fs.writeFileSync(groundDataFilePath, JSON.stringify(mapGroundData, null, 2), 'utf8');
    res.sendStatus(200);
  } catch (error) {
    console.error('Error writing to air-map-data.json:', error.message);
    // Send an error response
    res.status(500).json({ error: 'Failed to update air-map-data.json' });
  }
});

/**
 * Retrieves the JSON data from air-map-data.json
 */
app.get('/get-map-air-data', (req, res) => {
  try {
    const data = fs.readFileSync(airDataFilePath, 'utf8');
    const jsonData = JSON.parse(data);
    res.json(jsonData);
  } catch (error) {
    console.error('Error reading air-map-data.json:', error.message);
    res.status(500).json({ error: 'Failed to retrieve air map data' });
  }
});

/**
 * Retrieves the JSON data from ground-map-data.json
 */
app.get('/get-map-ground-data', (req, res) => {
  try {
    const data = fs.readFileSync(groundDataFilePath, 'utf8');
    const jsonData = JSON.parse(data);
    res.json(jsonData);
  } catch (error) {
    console.error('Error reading ground-map-data.json:', error.message);
    res.status(500).json({ error: 'Failed to retrieve ground map data' });
  }
});
//& ^^^^^^^This part is for Google Maps ^^^^^^^^^^^^^^^^


// Start web server on port 3000
app.listen(3000, () => {
  console.log('Server is listening on port 3000')
})



// ********** Util methods ***************
/**
 * This function reads the content of a specified file, appends a predefined instruction
 * along with the input text, and returns the updated content as a string.
 *
 * @param {string} text - The input text that will be analyzed.
 * @returns {Promise<string>} - A promise that resolves to the full content of the file
 * including the appended instruction and input text.
 */
async function extractSourcesFromText(text) {
  return new Promise(async (resolve, reject) => {
    try {
      const originalContent = await fs.readFileSync(gptPromptDataFilePath, 'utf8');
      const instruction = `\nThis is the input text you are to analyze: ${text}\n`;
      const updatedContent = originalContent + instruction;
      // Resolve the promise with the updated content
      resolve(updatedContent);
    } catch (error) {
      reject(new Error(`Error reading or processing the file: ${error.message}`));
    }
  });
}

/**
 * Takes in a prompt and uses the prompt for OpenAI API, and returns the result of the prompt.
 * @param {String} prompt The prompt
 * @param {String} model The LLM model, default is gpt-4o-mini
 * @returns
 */
async function getCompletion(prompt, context, model = "gpt-4o-mini") {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
  try {
    const response = await client.chat.completions.create({
      model: model,
      messages: [
        { role: "system", content: context },
        { role: "user", content: prompt },
      ],
      temperature: 0,
    });
    console.log(response.usage)

    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error fetching completion from OpenAI:', error);
    return 'Error occurred while getting completion.';
  }
}

/**
 * Return the device carbon info if it already exists in database. Otherwise, perform a carbon estimation on the device and return the carbon info of the device.
 * @param {String} newPhoneName The new device name. e.g. "iPhone 15"
 * @returns The JSON carbon data for the new device
 */
async function findOrAddDeviceToDatabase(newPhoneName) {
  let existingDevice = await checkPhoneExists(newPhoneName);
  if (existingDevice) {
    console.log('EXISTING DEVICE FOUND');
    return existingDevice;
  } else {
    console.log('ADDING NEW DEVICE');
    // Perform the Google search and document loading
    const docs = await productPCFGoogleSearch(newPhoneName, 2);
    // Analyze the keyword based on the loaded documents
    const analysisResult = await analyzeEnvironmentalReports(newPhoneName, docs);
    const formattedResult = analysisResult.replace(/```json|```/g, '');
    let newDevice = JSON.parse(formattedResult);
    newDevice.normalized_name = normalizeDeviceName(newDevice.device);
    newDevice.base_co2e = parseFloat(newDevice.base_co2e);
    newDevice = addCO2eToSpecs(newDevice);

    console.log('newDevice = ');
    console.log(newDevice);
    await insertDevices(newDevice);
    return newDevice;
  }
}


/**
 * Returns whether the two devices match with each other
 * @param {String} existingDeviceName The existing device name in the phone database
 * @param {String} newDeviceName The new device name.
 * @returns
 */
function matchDevice(existingDeviceName, newDeviceName) {
  const normalizedExisting = normalizeDeviceName(existingDeviceName);
  const normalizedNew = normalizeDeviceName(newDeviceName);

  console.log('normalizedExisting = ' + normalizedExisting);
  console.log('normalizedNew = ' + normalizedNew);
  console.log(normalizedExisting == normalizedNew);
  console.log(' ');
  return normalizedExisting == normalizedNew;
}

// Normalize a string: lowercase, trim spaces, and collapse multiple spaces
function normalizeDeviceName(name) {
  return name
    .toLowerCase()
    // Remove common unnecessary suffixes (word boundaries ensure we match standalone terms)
    // .replace(/\b(ultra|pro|max|plus|mini|lite|se|edge|global|international|unlocked|dual sim)\b/g, '')
    .replace(/\b(global|international|unlocked|dual sim)\b/g, '')
    // Remove connectivity indicators
    .replace(/\b(5g|4g|lte)\b/g, '')
    // Remove storage and RAM specs
    .replace(/\b(\d{1,4}gb(\s*ram)?)\b/g, '')
    // Remove finish types
    .replace(/\b(matte|glossy|ceramic|glass)\b/g, '')
    // Remove colors
    .replace(/\b(black|white|blue|green|silver|gold|red|purple|pink|yellow)\b/g, '')
    // Remove generation/year
    .replace(/\b(gen\s*\d+|20\d{2})\b/g, '')
    .replace(/\s+/g, ' ') // Collapse multiple spaces
    .trim(); // Remove leading/trailing spaces
}

/**
 * Takes in JSON data of a phone model, and adds the 'co2e' property to the specs section.
 * @param {JSON} data
 * @returns the updated JSON data with co2e value
 */
function addCO2eToSpecs(data) {
  const baseCO2e = parseFloat(data.base_co2e);
  data.specs.forEach((spec, index) => {
    const currentStorage = toGB(spec.storage);
    if (index === 0) {
      // First entry: co2e = base_co2e
      spec.co2e = baseCO2e;
    } else {
      // For subsequent entries, calculate co2e based on previous entry's storage
      const previousStorage = parseInt(data.specs[index - 1].storage);
      const previousCo2e = parseInt(data.specs[index - 1].co2e);
      const co2eIncrease = ((currentStorage - previousStorage) * (6 / 128));
      console.log('base CO2e = ' + baseCO2e);
      console.log('co2eIncrease = ' + co2eIncrease);
      spec.co2e = previousCo2e + co2eIncrease;
    }
    spec.co2e = Math.round(spec.co2e);
  });
  return data;
}

/**
   * Takes in the storage value and returns a numerical value in gigabytes (e.g. "256 GB" --> 256)
   * @param {String} storage the storage of a phone model (e.g. "256 GB", "1 TB")
   */
function toGB(storage) {
  const storageValue = parseFloat(storage);
  if (storage.includes("TB")) {
    return storageValue * 1024;
  } else if (storage.includes("GB")) {
    return storageValue;
  } else if (storage.includes("MB")) {
    return storageValue / 1024;
  }
  return storageValue;
}