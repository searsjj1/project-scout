#!/bin/bash

# Extract source data in a parseable format
echo "SOURCE_ID,ENTITY_ID,SOURCE_NAME,COUNTY,CITY,ACTIVE,v4_deactivated,source_profile"

# Use grep to extract line by line, then parse
grep -o "source_id:'[^']*'.*entity_id:'[^']*'.*source_name:'[^']*'.*county:'[^']*'.*city:'[^']*'" src/data/seedData.js | \
while IFS= read -r line; do
  source_id=$(echo "$line" | sed -n "s/.*source_id:'\([^']*\)'.*/\1/p")
  entity_id=$(echo "$line" | sed -n "s/.*entity_id:'\([^']*\)'.*/\1/p")
  source_name=$(echo "$line" | sed -n "s/.*source_name:'\([^']*\)'.*/\1/p")
  county=$(echo "$line" | sed -n "s/.*county:'\([^']*\)'.*/\1/p")
  city=$(echo "$line" | sed -n "s/.*city:'\([^']*\)'.*/\1/p")
  echo "$source_id,$entity_id,$source_name,$county,$city"
done
