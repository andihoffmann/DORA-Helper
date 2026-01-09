import pandas as pd
import json
import os

# Configuration
INPUT_FILE = 'psi_affiliations.xlsx'  # Replace with your actual file name
OUTPUT_FILE = 'psi_data.js'           # Output as .js for direct use in extension

def convert_excel_to_js():
    # Check if file exists
    if not os.path.exists(INPUT_FILE):
        print(f"Error: Input file '{INPUT_FILE}' not found.")
        print("Please place your Excel file in the same directory and rename it to 'psi_affiliations.xlsx' or update the script.")
        return

    print(f"Reading {INPUT_FILE}...")
    
    try:
        # Read Excel file
        df = pd.read_excel(INPUT_FILE)
        
        # Clean column names (strip whitespace)
        df.columns = df.columns.str.strip()
        
        # Initialize the dictionary
        psi_history = {}
        
        print("Processing rows...")
        
        for index, row in df.iterrows():
            # Extract Name
            lastname = str(row.get('LASTNAME', '')).strip()
            firstname = str(row.get('FirstNameInitial', '')).strip()
            
            if not lastname or lastname == 'nan':
                continue
                
            # Create Key: "Lastname, Firstname"
            key = f"{lastname}, {firstname}"
            
            # Extract Year from Source (e.g., "SAP2013" -> 2013)
            source = str(row.get('Source', '')).strip()
            year = None
            if source.startswith('SAP') and len(source) >= 7:
                try:
                    year = int(source[3:])
                except ValueError:
                    pass
            
            if not year:
                continue
                
            # Extract Unit Info
            # Mapping based on your provided table structure
            group = str(row.get('KST Gruppe DORA', '')).strip()
            section = str(row.get('KST Sektion DORA', '')).strip()
            lab = str(row.get('KST Lab DORA', '')).strip()
            division = str(row.get('KST Bereich DORA', '')).strip()
            
            # Handle 'nan' values
            if group == 'nan': group = ""
            if section == 'nan': section = ""
            if lab == 'nan': lab = ""
            if division == 'nan': division = ""
            
            record = {
                "year": year,
                "group": group,
                "section": section,
                "lab": lab,
                "division": division
            }
            
            if key not in psi_history:
                psi_history[key] = []
            
            # Avoid duplicates if any
            if record not in psi_history[key]:
                psi_history[key].append(record)
        
        # Write to JS file
        print(f"Writing to {OUTPUT_FILE}...")
        
        # Convert dict to JSON string
        json_str = json.dumps(psi_history, ensure_ascii=False, indent=4)
        
        # Wrap in JS variable assignment
        js_content = f"const PSI_HISTORY = {json_str}"
        
        with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
            f.write(js_content)
            
        print(f"Done! You can now upload '{OUTPUT_FILE}' in the DORA Helper options.")

    except Exception as e:
        print(f"An error occurred: {e}")

if __name__ == "__main__":
    convert_excel_to_js()
