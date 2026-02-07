import { supabase } from '@/integrations/supabase/client';

export interface NotionProperty {
  id: string;
  name: string;
  type: string;
  options?: { name: string; color?: string }[];
}

export const notionSchemaApi = {
  /**
   * Fetch the schema (properties) of a Notion database
   */
  async getSchema(databaseId: string): Promise<{
    success: boolean;
    properties: NotionProperty[];
    error?: string;
  }> {
    try {
      const { data, error } = await supabase.functions.invoke('notion-schema', {
        body: {
          action: 'get_schema',
          database_id: databaseId,
        },
      });

      if (error) throw error;

      return {
        success: data?.success ?? false,
        properties: data?.properties ?? [],
        error: data?.error,
      };
    } catch (error) {
      console.error('Error fetching Notion schema:', error);
      return {
        success: false,
        properties: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },

  /**
   * Create a new property in a Notion database
   */
  async createProperty(
    databaseId: string,
    propertyName: string,
    propertyType: string
  ): Promise<{
    success: boolean;
    property?: NotionProperty;
    error?: string;
  }> {
    try {
      const { data, error } = await supabase.functions.invoke('notion-schema', {
        body: {
          action: 'create_property',
          database_id: databaseId,
          property_name: propertyName,
          property_type: propertyType,
        },
      });

      if (error) throw error;

      return {
        success: data?.success ?? false,
        property: data?.property,
        error: data?.error,
      };
    } catch (error) {
      console.error('Error creating Notion property:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
};
