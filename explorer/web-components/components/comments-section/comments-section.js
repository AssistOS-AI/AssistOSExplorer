function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function getCommentAuthor(comment) {
    const email = String(comment?.userEmail || '').trim();
    const userName = String(comment?.userName || '').trim();
    return {
        name: userName,
        email
    };
}

export class CommentsSection{
    constructor(element, invalidate, props) {
        this.element = element;
        this.invalidate = invalidate;
        this.props = props;
        this.documentPresenter = this.element.closest("document-view-page").webSkelPresenter;
        this.comments = this.documentPresenter._document.comments.messages;
        if(this.props.chapterId){
            let chapterItem = this.element.closest("chapter-item");
            this.chapterPresenter = chapterItem.webSkelPresenter;
            this.comments = this.chapterPresenter.chapter.comments.messages;
        }
        if(this.props.paragraphId){
            let paragraphItem = this.element.closest("paragraph-item");
            this.paragraphPresenter = paragraphItem.webSkelPresenter;
            this.comments = this.paragraphPresenter.paragraph.comments.messages;
        }
        this.invalidate();
    }
    beforeRender() {
        let commentsHTML = "";
        for(let comment of this.comments){
            const author = getCommentAuthor(comment);
            const nameHtml = author.name
                ? `<div class="comment-username">${escapeHtml(author.name)}</div>`
                : "";
            const emailHtml = author.email
                ? `<div class="comment-email">${escapeHtml(author.email)}</div>`
                : "";
            commentsHTML += `<div class="comment">
                                <div class="user-details-container">
                                    <div class="user-details">
                                        <div class="user-icon"></div>
<!--                                        <img src="./assets/icons/user.svg" class="user-icon">-->
                                        <div class="user-info">
                                            ${nameHtml}
                                            ${emailHtml}
                                        </div>
                                    </div>
                                    <img data-local-action="deleteComment ${escapeHtml(comment.id)}" src="/explorer/assets/icons/check.svg" class="check-icon pointer">
                                </div>
                                <div class="comment-message">${escapeHtml(comment.message)}</div>
                             </div>`;
        }
        this.commentsHTML = commentsHTML;
    }
    async deleteComment(icon, id){
        this.comments = this.comments.filter(comment => comment.id !== id);
        let commentItem = icon.closest(".comment");
        commentItem.remove();
        if(this.paragraphPresenter){
            await this.paragraphPresenter.updateComments(this.comments);
        } else if(this.chapterPresenter){
            await this.chapterPresenter.updateComments(this.comments);
        } else {
            await this.documentPresenter.updateComments(this.comments);
        }
    }
    closeComments(button){
        this.element.remove();
    }
}
