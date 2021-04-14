/*
Author- Jacob Gaeta
Date- 1/11/2021
This program defines a lambda function that takes order information in the 
request body. It checks this information against the inventory database in 
order to ensure it has the  sufficient inventory to complete the order. It 
returns "true" or "false" in the response body depending on the outcome of 
the inventory check. True if enough inventory for order completion, false otherwise.
*/

'use strict';
const AWS = require('aws-sdk');

exports.handler = async (event) => {

  // Initialize variables for use in program
  const documentClient = new AWS.DynamoDB.DocumentClient();
  let ingredientCounts = [];
  let missingIngredients = [];

  // Extract neccessary information from event body and assign to vars
  const { orderId, mealOrders } = JSON.parse(event.body);

  const response = {
    headers: {
      "Content-Type": "application/json"
    },
    "body": ""
  };

  const orderParams = {
    TableName: "Orders",
    Item: {
      orderId: orderId,
      mealOrders: mealOrders
    }
  }
  
  const mealParams = {
    TableName: "Meals",
    Key: {
    }
  };

  // Initialize complete list of ingredients needed to complete order
  let ingredientsList = await makeIngredientList(mealParams, mealOrders, documentClient);

  // Intialize array without ingredient duplicates
  let uniqueIngredients = delArrayDupes(ingredientsList);
  const ingredientParams = {
    TableName: "Ingredients",
    Key:{
    }
  };
  try {
    // Assign array to list of ingredient counts
    ingredientCounts = await getIngredientCounts(uniqueIngredients, ingredientParams, ingredientCounts, documentClient);

    // Assign array to list of missing ingredients
    missingIngredients = await getMissingIngredients(ingredientsList, ingredientCounts, uniqueIngredients);
  }
  catch(err) {
    response.body = `Unable to retrieve ingredient counts from table`
    return response;
  }

  // Missing Ingredients, return false response to OrderAccepted, remove specified meal
  if(missingIngredients.length !== 0) {
    orderParams["Item"]["orderAccepted"] = false;

    // Put order in table with orderId and list of meals
    await documentClient.put(orderParams).promise();
    response.body = "false";
    return response;
  }
    

    try {
      // Update menu to reflect missing inventory
      await updateMenu(missingIngredients, mealOrders, mealParams, documentClient);
    }
    catch(err) {
      response.body = `Unable to update menu`;
      return response;
    }

    response.body = false;
    return response;
  }

  try {
    // Update orderAccepted to true and response body to true
    await orderResult(true, orderId, documentClient);
  }
  catch(err) {
    response.body = `Unable to update orderAccepted in Table`;
    return response;
  }

  try {
    // Update ingredient counts in "Ingredients" Table
    await updateIngredientCount(ingredientsList, documentClient);
    orderParams["Item"]["orderAccepted"] = true;
  }
  catch(err) {
    response.body = `Unable to update ingredient counts in Table`;
    return response;
  }

  response.body = "true";
  return response;   
};


/*
Function Definitions Start Here ---------------------------------------------------------------------------------------------
*/

  // Uses meal names to retrieve ingredients required from "Meals" table, returns list of needed ingredients
  async function makeIngredientList(mealParams, mealOrders, documentClient) {
    let ingredientsList = [];
    for (let i = 0; i < mealOrders.length; i++) {
        mealParams["Key"]["mealName"] = mealOrders[i];
        let mealResponse = await documentClient.get(mealParams).promise();
        ingredientsList = ingredientsList.concat(mealResponse["Item"]["ingredients"]);
        }

    return ingredientsList;
  }

  // Accepts array as parameter and returns an array without duplicates
  function delArrayDupes(arrayWithDupes) {
      let setFromArray = new Set(arrayWithDupes);
      return Array.from(setFromArray);
  }

/*
Populate ingredient count array that is parallel to uniqueIngredients array.
i.e. uniqueIngredients = ["cheese", "hotdog"]
ingredientCounts =  [5,3] -> count of cheese = 5, count of hotdog = 3
*/
async function getIngredientCounts(uniqueIngredients, ingredientParams, ingredientCounts, documentClient) {

  for (let j = 0; j < uniqueIngredients.length; j++) {
    ingredientParams["Key"]["ingName"] = uniqueIngredients[j];
    let ingCounts = await documentClient.get(ingredientParams).promise();
    ingredientCounts[j] = ingCounts["Item"]["ingCount"];
  }
  return ingredientCounts;
}

/* 
Iterates through ingredients list and decrements elements of ingredientCounts
that correspond to each ingredient
*/ 
async function getMissingIngredients(ingredientsList, ingredientCounts, uniqueIngredients) {
  let ingIndex, ingCount;
  let missingIngredients = [];
  for (let k = 0; k < ingredientsList.length; k++) {
    ingIndex = uniqueIngredients.indexOf(ingredientsList[k]);
    ingCount = ingredientCounts[ingIndex];
    if(ingCount > 0) {
      ingredientCounts[ingIndex]--;
    }

    else {
      // Ingredient is unavailable, push to missingIngredients list
      missingIngredients.push(ingredientsList[k]);
    }
  }
  return missingIngredients;
}

// Updates orderAccepted in "Orders" Table to true or false (depending on orderStatus)
async function orderResult(orderStatus, orderId, documentClient) {
  const orderAcceptedParams = {
    TableName: "Orders",
    Key: {
        orderId: orderId
    },
    UpdateExpression: "set orderAccepted = :n",
    ExpressionAttributeValues: {
        ":n": orderStatus
    },
    ReturnValues: "UPDATED_NEW"
  };

  await documentClient.update(orderAcceptedParams).promise();
}

  /*
  Accepts a list of missing ingredients and assembles a list of meals that require 
  the missing ingredients. Passes array of unavailable meals to dummy function,
  removeMealsFromMenu 
  */
 async function updateMenu(missingIngredients, mealOrders, mealParams, documentClient) {
  let meal;
  let uniqueMissingIngredients = delArrayDupes(missingIngredients);
  let mealIngredientsArray = [];
  let missingMeals = [];

  // Iterates through list of meals in customer order
  for(let mIdx = 0; mIdx < mealOrders.length; mIdx++) {
    mealParams["Key"]["mealName"] = mealOrders[mIdx];
    meal = await documentClient.get(mealParams).promise();
    // Assign ingredients array to current meal
    mealIngredientsArray = meal["Item"]["ingredients"];
    
    // Iterates through list of missing ingredients 
    for(let iIdx = 0; iIdx < uniqueMissingIngredients.length; iIdx++) {
      // Conditional triggered when meal contains a missing ingredient
      if(mealIngredientsArray.includes(uniqueMissingIngredients[iIdx])) {
          missingMeals.push(mealOrders[mIdx]);
          break;
      }
    }
  }
  // Dummy API Call
  removeMealsFromMenu(missingMeals);
}

// Updates count of ingredients in "Ingredients" Table
async function updateIngredientCount(ingredientsList, documentClient) {

  const changeIngredientParams = {
    TableName: "Ingredients",
    Key: {
    },
    UpdateExpression: "add ingCount :num",
    ExpressionAttributeValues: {
        ":num": -1
    },
    ReturnValues: "UPDATED_NEW"
  };

  // Iterate through ingredients list and search ingredient table to decrement food items
  for (let l = 0; l < ingredientsList.length; l++) {
    changeIngredientParams["Key"]["ingName"] = ingredientsList[l];
    await documentClient.update(changeIngredientParams).promise();
  }
}

// Dummy api call to remove meals
async function removeMealsFromMenu(missingMeals) {

}
