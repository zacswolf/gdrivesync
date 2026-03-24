type FetchLike = typeof fetch;

export interface SlidesApiPresentation {
  title?: string;
  slides?: SlidesApiSlide[];
}

export interface SlidesApiSlide {
  objectId?: string;
  slideProperties?: {
    isSkipped?: boolean;
  };
  pageProperties?: {
    pageBackgroundFill?: {
      stretchedPictureFill?: {
        contentUrl?: string;
      };
    };
  };
  pageElements?: SlidesApiPageElement[];
}

export interface SlidesApiPageElement {
  objectId?: string;
  title?: string;
  description?: string;
  shape?: {
    placeholder?: {
      type?: string;
    };
    text?: {
      textElements?: SlidesApiTextElement[];
    };
  };
  image?: {
    contentUrl?: string;
    sourceUrl?: string;
  };
}

export interface SlidesApiTextElement {
  paragraphMarker?: {
    bullet?: {
      nestingLevel?: number;
    };
  };
  textRun?: {
    content?: string;
  };
  autoText?: {
    content?: string;
  };
}

export class SlidesClient {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async getPresentation(accessToken: string, presentationId: string): Promise<SlidesApiPresentation> {
    const url = new URL(`https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}`);
    url.searchParams.set(
      "fields",
      "title,slides(objectId,slideProperties(isSkipped),pageProperties(pageBackgroundFill(stretchedPictureFill(contentUrl))),pageElements(objectId,title,description,shape(placeholder(type),text(textElements(paragraphMarker(bullet(nestingLevel)),textRun(content),autoText(content)))),image(contentUrl,sourceUrl)))"
    );

    const response = await this.fetchImpl(url, {
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`Google Slides API request failed with status ${response.status}.`);
    }

    return (await response.json()) as SlidesApiPresentation;
  }
}
